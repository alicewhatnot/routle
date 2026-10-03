#!/usr/bin/env python3

import colorsys
import csv
import io
import json
import math
import urllib.request
import zipfile
import zlib
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import NamedTuple, Optional

GTFS_URL = "https://api.ember.to/v1/gtfs/static/"  # public endpoint, no login needed
TEMPLATE_PATH = Path(__file__).parent / "map_template.html"
MAX_POINTS_PER_LINE = 500  # long route lines are thinned so the map stays fast
DAYS_TO_AVERAGE = 28  # "buses per day" is averaged over this many days
SECONDS_PER_UNIT = (3600, 60, 1)  # hours, minutes, seconds


class City(NamedTuple):
    name: str
    latitude: float
    longitude: float
    radius_km: float  # a stop within this distance of the centre counts as "in" the city


# Edit this list to change which cities are reported.
MAJOR_CITIES = [
    City("Aberdeen", 57.1497, -2.0943, 7),
    City("Dundee", 56.4620, -2.9707, 6),
    City("Edinburgh", 55.9533, -3.1883, 9),
    City("Glasgow", 55.8642, -4.2518, 9),
    City("Inverness", 57.4778, -4.2247, 6),
    City("Perth", 56.3950, -3.4308, 5),
    City("Stirling", 56.1165, -3.9369, 5),
    City("Dunfermline", 56.0717, -3.4522, 5),
]


class StopTime(NamedTuple):
    """One stop on one trip, with its scheduled times as 'HH:MM:SS' text."""
    sequence: int
    stop_id: str
    arrival: str
    departure: str


@dataclass
class TripSummary:
    """Numbers worked out from every scheduled trip."""
    trips_per_day: dict = field(default_factory=lambda: defaultdict(float))  # (route_id, direction) -> average
    max_duration_mins: dict = field(default_factory=lambda: defaultdict(int))  # route_id -> minutes
    longest_trips: dict = field(default_factory=dict)  # (route_id, direction) -> (trip row, stop times)


# ---------------------------------------------------------------- reading the feed

def download_gtfs(url: str) -> zipfile.ZipFile:
    """Download the GTFS zip file and return it ready to read."""
    request = urllib.request.Request(url, headers={"User-Agent": "routle-map/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return zipfile.ZipFile(io.BytesIO(response.read()))


def read_table(gtfs_zip: zipfile.ZipFile, filename: str) -> list:
    """Return the rows of one GTFS text file as a list of dicts ([] if the file is missing)."""
    if filename not in gtfs_zip.namelist():
        return []
    with gtfs_zip.open(filename) as raw_file:
        return list(csv.DictReader(io.TextIOWrapper(raw_file, encoding="utf-8-sig")))


def load_stop_times(gtfs_zip: zipfile.ZipFile) -> dict:
    """Return {trip_id: [StopTime, ...]} with each trip's stops in order."""
    stop_times_by_trip = defaultdict(list)
    for row in read_table(gtfs_zip, "stop_times.txt"):
        arrival = row.get("arrival_time") or row.get("departure_time") or ""
        departure = row.get("departure_time") or row.get("arrival_time") or ""
        stop_times_by_trip[row["trip_id"]].append(
            StopTime(int(row["stop_sequence"]), row["stop_id"], arrival, departure))
    for stop_times in stop_times_by_trip.values():
        stop_times.sort()
    return stop_times_by_trip


def load_shapes(gtfs_zip: zipfile.ZipFile) -> dict:
    """Return {shape_id: [[lat, lon], ...]}: the drawn path of each route variant (may be empty)."""
    points_by_shape = defaultdict(list)
    for row in read_table(gtfs_zip, "shapes.txt"):
        points_by_shape[row["shape_id"]].append(
            (int(row["shape_pt_sequence"]), float(row["shape_pt_lat"]), float(row["shape_pt_lon"])))
    return {shape_id: [[round(lat, 5), round(lon, 5)] for _, lat, lon in sorted(points)]
            for shape_id, points in points_by_shape.items()}


# ---------------------------------------------------------------- small helpers

def time_to_seconds(time_text: str) -> int:
    """Convert 'HH:MM:SS' to seconds. GTFS allows hours past 24 for trips running after midnight."""
    return sum(int(part) * unit for part, unit in zip(time_text.split(":"), SECONDS_PER_UNIT))


def minutes_between(start_time: str, end_time: str) -> Optional[int]:
    """Minutes from one 'HH:MM:SS' time to another, or None if either is missing or invalid."""
    try:
        return round((time_to_seconds(end_time) - time_to_seconds(start_time)) / 60)
    except ValueError:
        return None


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Straight-line distance between two points on Earth (haversine formula)."""
    to_radians = math.pi / 180
    half_dlat = (lat2 - lat1) * to_radians / 2
    half_dlon = (lon2 - lon1) * to_radians / 2
    a = (math.sin(half_dlat) ** 2
         + math.cos(lat1 * to_radians) * math.cos(lat2 * to_radians) * math.sin(half_dlon) ** 2)
    return 12742 * math.asin(math.sqrt(a))  # 12742 km = Earth's diameter


def find_city(stop: dict) -> Optional[str]:
    """Name of the major city this stop is in, or None."""
    latitude, longitude = float(stop["stop_lat"]), float(stop["stop_lon"])
    for city in MAJOR_CITIES:
        if distance_km(latitude, longitude, city.latitude, city.longitude) <= city.radius_km:
            return city.name
    return None


def thin_points(points: list, max_points: int = MAX_POINTS_PER_LINE) -> list:
    """Keep roughly max_points evenly spaced points (always keeping the last one)."""
    step = max(1, len(points) // max_points)
    thinned = points[::step]
    return thinned if thinned[-1] == points[-1] else thinned + [points[-1]]


def choose_colour(route_id: str, colour_from_feed: str) -> str:
    """Use the feed's route colour, or make a stable one from the route id."""
    if colour_from_feed:
        return "#" + colour_from_feed.lstrip("#")
    hue = (zlib.crc32(route_id.encode()) % 360) / 360
    red, green, blue = (int(channel * 255) for channel in colorsys.hls_to_rgb(hue, 0.4, 0.75))
    return f"#{red:02x}{green:02x}{blue:02x}"


# ---------------------------------------------------------------- how often buses run

class ServiceCalendar:
    """Works out on how many days each service (e.g. 'weekdays only') runs.

    Looks DAYS_TO_AVERAGE days ahead from today (or at the feed's own dates if it ends sooner).
    """

    def __init__(self, gtfs_zip: zipfile.ZipFile):
        self.regular_rules = {row["service_id"]: row for row in read_table(gtfs_zip, "calendar.txt")}
        self.exceptions = defaultdict(dict)  # service_id -> {"YYYYMMDD": "1" (added) or "2" (removed)}
        for row in read_table(gtfs_zip, "calendar_dates.txt"):
            self.exceptions[row["service_id"]][row["date"]] = row["exception_type"]
        self.has_calendar_data = bool(self.regular_rules or self.exceptions)
        self.days = self._choose_days()
        self._days_running_cache = {}

    @staticmethod
    def _parse_date(text: str) -> date:
        return datetime.strptime(text, "%Y%m%d").date()

    def _choose_days(self) -> list:
        """The list of dates that 'buses per day' is averaged over."""
        feed_dates = [self._parse_date(rule[key]) for rule in self.regular_rules.values()
                      for key in ("start_date", "end_date")]
        feed_dates += [self._parse_date(text) for days in self.exceptions.values() for text in days]
        if not feed_dates:
            return [date.today()]  # no calendar in the feed: assume every service runs every day
        first_day = max(date.today(), min(feed_dates))
        if first_day > max(feed_dates):
            first_day = min(feed_dates)  # the feed is entirely in the past, so use its own dates
        number_of_days = min(DAYS_TO_AVERAGE, (max(feed_dates) - first_day).days + 1)
        return [first_day + timedelta(days=offset) for offset in range(number_of_days)]

    def _runs_on(self, service_id: str, day: date) -> bool:
        exception = self.exceptions[service_id].get(day.strftime("%Y%m%d"))
        if exception:
            return exception == "1"
        rule = self.regular_rules.get(service_id)
        if rule is None:
            return False
        in_date_range = self._parse_date(rule["start_date"]) <= day <= self._parse_date(rule["end_date"])
        return in_date_range and rule[day.strftime("%A").lower()] == "1"

    def days_running(self, service_id: str) -> int:
        """How many of the chosen days this service runs on."""
        if service_id not in self._days_running_cache:
            if self.has_calendar_data:
                count = sum(self._runs_on(service_id, day) for day in self.days)
            else:
                count = len(self.days)
            self._days_running_cache[service_id] = count
        return self._days_running_cache[service_id]


def summarise_trips(trips: list, stop_times_by_trip: dict, calendar: ServiceCalendar) -> TripSummary:
    """Go through every trip, working out durations, trips per day and each route's longest trips."""
    summary = TripSummary()
    for trip in trips:
        stop_times = stop_times_by_trip.get(trip["trip_id"])
        if not stop_times:
            continue
        route_id = trip["route_id"]
        key = (route_id, trip.get("direction_id", "0"))

        duration = minutes_between(stop_times[0].departure, stop_times[-1].arrival)
        if duration and duration > summary.max_duration_mins[route_id]:
            summary.max_duration_mins[route_id] = duration

        summary.trips_per_day[key] += calendar.days_running(trip.get("service_id", "")) / len(calendar.days)

        if key not in summary.longest_trips or len(stop_times) > len(summary.longest_trips[key][1]):
            summary.longest_trips[key] = (trip, stop_times)
    return summary


# ---------------------------------------------------------------- building the output

def build_route(route_id: str, route_row: dict, summary: TripSummary, stops: dict, shapes: dict) -> Optional[dict]:
    """Collect everything about one route; returns None if it has no usable trips."""
    longest_trips = [trip_and_times for (rid, _), trip_and_times in summary.longest_trips.items()
                     if rid == route_id]
    lines, start_stop_names = [], set()
    for trip, stop_times in longest_trips:
        stop_ids = [stop_time.stop_id for stop_time in stop_times if stop_time.stop_id in stops]
        if not stop_ids:
            continue
        start_stop_names.add(stops[stop_ids[0]]["stop_name"])  # each direction has its own start
        line = shapes.get(trip.get("shape_id", "")) or [
            [round(float(stops[stop_id]["stop_lat"]), 5), round(float(stops[stop_id]["stop_lon"]), 5)]
            for stop_id in stop_ids]
        if len(line) > 1:
            lines.append(thin_points(line))
    if not lines:
        return None

    # The route's longest trip tells us its stops, ends and cities.
    _, main_stop_times = max(longest_trips, key=lambda trip_and_times: len(trip_and_times[1]))
    main_stop_ids = [stop_time.stop_id for stop_time in main_stop_times if stop_time.stop_id in stops]
    first_stop, last_stop = stops[main_stop_ids[0]], stops[main_stop_ids[-1]]
    end_cities = {find_city(first_stop), find_city(last_stop)}
    cities_passed = []
    for stop_id in main_stop_ids:
        city = find_city(stops[stop_id])
        if city and city not in end_cities and city not in cities_passed:
            cities_passed.append(city)

    buses_per_day = max(count for (rid, _), count in summary.trips_per_day.items() if rid == route_id)
    return {
        "id": route_id,
        "name": " ".join(part for part in (route_row.get("route_short_name"), route_row.get("route_long_name")) if part),
        "colour": choose_colour(route_id, route_row.get("route_color") or ""),
        "lines": lines,
        "start_stops": sorted(start_stop_names),
        "info": {
            "num_stops": len(main_stop_ids),
            "max_duration_mins": summary.max_duration_mins[route_id] or None,
            "start_stop": first_stop["stop_name"],
            "end_stop": last_stop["stop_name"],
            "major_cities": cities_passed,
            "buses_per_day": round(buses_per_day, 1),
            "buses_per_day_label": "<1" if buses_per_day < 1 else str(round(buses_per_day)),
        },
        "stop_ids": main_stop_ids,
    }


def build_stop_list(routes: list, stops: dict) -> list:
    """Unique [name, latitude, longitude] entries for every stop used. A plain list, so no JSON keys can clash."""
    seen, stop_list = set(), []
    for stop_id in sorted({stop_id for route in routes for stop_id in route["stop_ids"]}):
        stop = stops[stop_id]
        entry = (stop["stop_name"], round(float(stop["stop_lat"]), 5), round(float(stop["stop_lon"]), 5))
        if entry not in seen:
            seen.add(entry)
            stop_list.append(list(entry))
    return stop_list


def check_no_duplicate_keys(json_text: str) -> None:
    """Safety check: raise an error if any JSON object repeats a key."""
    def reject_duplicates(pairs):
        keys = [key for key, _ in pairs]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate JSON keys: " + str(sorted({k for k in keys if keys.count(k) > 1})[:5]))
        return dict(pairs)
    json.loads(json_text, object_pairs_hook=reject_duplicates)


def write_outputs(routes: list, stop_list: list) -> None:
    """Write the map page, the JSON data and the CSV summary."""
    for route in routes:
        del route["stop_ids"]  # only needed to build the stop list
    json_text = json.dumps({"routes": routes, "stops": stop_list}, separators=(",", ":"))
    check_no_duplicate_keys(json_text)

    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    Path("ember-map.html").write_text(template.replace("__MAP_DATA__", json_text), encoding="utf-8")
    Path("ember-network.json").write_text(json_text, encoding="utf-8")

    with open("ember-routes.csv", "w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["route", "start_stop", "end_stop", "num_stops",
                         "max_duration_mins", "major_cities", "buses_per_day"])
        for route in routes:
            info = route["info"]
            writer.writerow([route["name"], info["start_stop"], info["end_stop"], info["num_stops"],
                             info["max_duration_mins"], "; ".join(info["major_cities"]),
                             info["buses_per_day_label"]])


def main() -> None:
    gtfs_zip = download_gtfs(GTFS_URL)
    route_rows = {row["route_id"]: row for row in read_table(gtfs_zip, "routes.txt")}
    stops = {row["stop_id"]: row for row in read_table(gtfs_zip, "stops.txt")}
    trips = read_table(gtfs_zip, "trips.txt")

    summary = summarise_trips(trips, load_stop_times(gtfs_zip), ServiceCalendar(gtfs_zip))
    shapes = load_shapes(gtfs_zip)

    routes = [route for route_id, route_row in route_rows.items()
              if (route := build_route(route_id, route_row, summary, stops, shapes))]
    stop_list = build_stop_list(routes, stops)
    write_outputs(routes, stop_list)
    print(f"Done: {len(routes)} routes, {len(stop_list)} stops -> "
          "ember-map.html, ember-network.json, ember-routes.csv")


if __name__ == "__main__":
    main()



