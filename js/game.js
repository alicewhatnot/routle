// ---- Config --------------------------------------------------------------
const ROUTES_URL = "json/ember_routes.json";
const LOCATIONS_URL = "json/ember_locations_detailed.json";
const POPULAR_URL = "json/ember_locations_popular.json";
const MAX_GUESSES = 5;

// ---- Helpers -------------------------------------------------------------
const $ = id => document.getElementById(id);
const clean = s => String(s).replace(/\s+/g, " ").trim();
const key = s => clean(s).toLowerCase();
const esc = s => String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const destination = r => r.stops[r.stops.length - 1];
const clueLogo = document.querySelector(".clue-logo");

// ---- Timer ---------------------------------------------------------------

const Timer = (() => {
    let startedAt = 0;
    let handle = null;
    let saved = 0;

    const el = $("timer");

    const fmt = seconds =>
        String(Math.floor(seconds / 60)).padStart(2, "0") +
        ":" +
        String(seconds % 60).padStart(2, "0");

    const elapsed = () =>
        Math.floor((Date.now() - startedAt) / 1000);

    return {

        start() {
            this.stop();

            saved = 0;
            startedAt = Date.now();
            el.textContent = fmt(0);

            handle = setInterval(() => {
                el.textContent = fmt(elapsed());
            }, 250);
        },

        stop() {
            if (handle) {
                saved = elapsed();
                clearInterval(handle);
                handle = null;
                el.textContent = fmt(saved);
            }

            return fmt(saved);
        },

        reset() {
            clearInterval(handle);
            handle = null;
            saved = 0;
            el.textContent = fmt(0);
        },

        saved: () => fmt(saved)
    };
})();


// ---- End screen ----------------------------------------------------------

const EndScreen = (() => {

    const api = {

        show({ won, guesses, answer }) {

            const time = Timer.stop();

            $("endTitle").textContent =
                won ? "Congratulations!" : "Maybe next time…";

            $("endTime").textContent = time;
            $("endGuesses").textContent = guesses;
            $("endAnswer").textContent = answer;

            $("end").classList.add("open");

            $("again").focus();
        },

        hide() {
            $("end").classList.remove("open");
        }
    };

    $("again").addEventListener("click", () => {
        api.hide();
        Timer.reset();
        newGame();
    });

    return api;
})();


// ---- Start cities --------------------------------------------------------

const START_CITIES = [
    { name: "Edinburgh", lat: 55.9533, lng: -3.1883 },
    { name: "Glasgow",   lat: 55.8642, lng: -4.2518 },
    { name: "Dundee",    lat: 56.4620, lng: -2.9707 },
    { name: "Aberdeen",  lat: 57.1497, lng: -2.0943 },
    { name: "Inverness", lat: 57.4778, lng: -4.2247 }
];

const cityOf = stop =>
    START_CITIES.find(c =>
        stop.toLowerCase().includes(c.name.toLowerCase())
    );


// ---- Data extraction -----------------------------------------------------

const numbers = v =>
    typeof v === "number" ? [v]
    : typeof v === "string" && v.trim() !== "" && !isNaN(v)
        ? [Number(v)]
    : Array.isArray(v)
        ? v.flatMap(numbers)
    : v && typeof v === "object"
        ? Object.values(v).flatMap(numbers)
    : [];

function avgDuration(r) {
    const src =
        r.durations ??
        r.duration ??
        r.averageDuration ??
        r.durationMinutes;

    const n = numbers(src);

    return n.length
        ? n.reduce((a, b) => a + b, 0) / n.length
        : null;
}

function weeklyFrequency(r) {
    const src =
        r.frequency ??
        r.frequencies ??
        r.departures ??
        r.schedule ??
        r.services;

    if (src == null) return null;

    const day = v =>
        Array.isArray(v)
            ? v.length
            : numbers(v).reduce((a, b) => a + b, 0);

    if (typeof src === "object" && !Array.isArray(src)) {
        return Object.values(src)
            .reduce((sum, v) => sum + day(v), 0);
    }

    return day(src);
}


// ---- Geo -----------------------------------------------------------------

const rad = d => d * Math.PI / 180;

function distanceKm(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);

    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.lat)) *
        Math.cos(rad(b.lat)) *
        Math.sin(dLng / 2) ** 2;

    return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function compass(a, b) {
    const y =
        Math.sin(rad(b.lng - a.lng)) *
        Math.cos(rad(b.lat));

    const x =
        Math.cos(rad(a.lat)) *
        Math.sin(rad(b.lat)) -
        Math.sin(rad(a.lat)) *
        Math.cos(rad(b.lat)) *
        Math.cos(rad(b.lng - a.lng));

    const deg =
        (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

    return [
        "north",
        "north-east",
        "east",
        "south-east",
        "south",
        "south-west",
        "west",
        "north-west"
    ][Math.round(deg / 45) % 8];
}


// ---- State ---------------------------------------------------------------

let routes = [];
let destinations = [];   // final stops only (possible answers)
let guessable = [];      // every stop the player may guess
let coords = new Map();
let rank = new Map();
let target = null;
let clueText = [];
let wrong = [];
let won = false;
let lost = false;


function coordsOf(stop) {
    const k = key(stop);

    if (coords.has(k))
        return coords.get(k);

    for (const [name, c] of coords)
        if (name.includes(k) || k.includes(name))
            return c;

    return null;
}


function rankOf(stop) {
    const k = key(stop);

    if (rank.has(k))
        return rank.get(k);

    for (const [name, i] of rank)
        if (name.includes(k) || k.includes(name))
            return i;

    return Infinity;
}


// ---- Setup ---------------------------------------------------------------

function loadRoutes(data) {
    return Object.entries(data.routes)
        .map(([name, r]) => {

            const stops = r.stopNames.map(clean);

            return {
                name: clean(name),
                stops,
                city: cityOf(stops[0]),
                duration: avgDuration(r),
                weekly: weeklyFrequency(r)
            };
        })
        .filter(r =>
            r.stops.length >= 3 &&
            r.city
        );
}


function buildClues(r) {

    const dest = destination(r);

    const startPos =
        coordsOf(r.stops[0]) ||
        r.city;

    const destPos =
        coordsOf(dest);

    const middle =
        r.stops.slice(1, -1);

    const major =
        [...middle]
            .sort((a, b) =>
                rankOf(a) - rankOf(b)
            )[0];

    const clues = [];

    if (r.duration != null) {

        const m = Math.round(r.duration);

        clues.push(
            `The average journey takes ${
                m >= 60
                    ? Math.floor(m / 60) + "h "
                    : ""
            }${m % 60}min.`
        );

    } else {
        // Estimate rounded to the nearest 10 (never below 10)
        const approx =
            Math.max(10, Math.round(r.stops.length / 10) * 10);

        clues.push(
            `This route has roughly ${approx} stops.`
        );
    }

    clues.push(
        r.weekly != null
            ? `It runs about ${Math.round(r.weekly)} services a week.`
            : `The destination name has ${
                dest.replace(/[^a-z]/gi, "").length
              } letters.`
    );

    if (destPos) {

        const km =
            distanceKm(startPos, destPos);

        clues.push(
            `The destination is about ${Math.round(km)} km (${Math.round(km * 0.621)} miles) from the start as the crow flies.`
        );

        clues.push(
            `The destination lies to the ${compass(startPos, destPos)} of the start.`
        );

    } else {

        clues.push(
            `The destination name has ${
                dest.replace(/[^a-z]/gi, "").length
            } letters.`
        );

        clues.push(
            `The destination begins with “${dest[0]}”.`
        );
    }

    clues.push(
        `The same route also passes through ${major}.`
    );

    return clues;
}


// ---- Game start ----------------------------------------------------------

function newGame() {

    target = pick(routes);

    clueText = buildClues(target);

    wrong = [];

    won = false;
    lost = false;

    $("msg").textContent = "";

    // Reset input
    $("in").value = "";

    // Start timer
    Timer.start();

    if (window.focusStart)
        window.focusStart(target.city);

    render();
}


// ---- Rendering -----------------------------------------------------------

function cluesShown() {
    return lost
        ? clueText.length
        : Math.min(
            clueText.length,
            wrong.length + 1
        );
}


function render() {

    $("start").innerHTML =
        `<b>Starts in</b> ${esc(target.city.name)}`;

    const unlocked = cluesShown();

    $("clues").innerHTML =
        clueText.map((text, i) =>
            i < unlocked
                ? `<div class="clue">
                       <b>Clue ${i + 1}</b>
                       ${esc(text)}
                   </div>`
                : `<div class="clue lock">
                       <b>Clue ${i + 1}</b>
                       🔒 Unlocks after a wrong guess
                   </div>`
        ).join("");
    
    $("clues").appendChild(clueLogo);

    $("left").textContent =
        "Guesses left: " +
        (MAX_GUESSES - wrong.length);

    $("prev").innerHTML =
        wrong
            .map(d =>
                `<li class="w">✗ ${esc(d)}</li>`
            )
            .join("") +

        (won
            ? `<li class="r">
                   ✓ ${esc(destination(target))}
               </li>`
            : "");

    $("in").disabled =
        $("go").disabled =
        won || lost;
}


// ---- Game logic ----------------------------------------------------------

function guess() {

    if (!target || won || lost)
        return;

    const value =
        key($("in").value);

    // Validate against every known stop, not just route destinations
    const match =
        guessable.find(
            d => d.toLowerCase() === value
        );

    if (!match) {
        $("msg").textContent =
            "Pick a stop from the list.";
        return;
    }

    if (wrong.includes(match)) {
        $("msg").textContent =
            "You've already guessed that one.";
        return;
    }

    $("in").value = "";

    // Correct answer
    if (match === destination(target)) {

        won = true;

        $("msg").textContent =
            `🎉 Solved in ${wrong.length + 1}! ${target.name}`;

        render();

        EndScreen.show({
            won: true,
            guesses: wrong.length + 1,
            answer: destination(target)
        });

        return;
    }

    // Wrong answer
    wrong.push(match);

    if (wrong.length >= MAX_GUESSES) {

        lost = true;

        $("msg").textContent =
            `Out of guesses! It was ${destination(target)} (${target.name}).`;

        render();

        EndScreen.show({
            won: false,
            guesses: MAX_GUESSES,
            answer: destination(target)
        });

        return;
    }

    $("msg").textContent =
        "Not that one – a new clue is unlocked.";

    render();
}


$("go").onclick = guess;

$("in").onkeydown = e => {
    if (e.key === "Enter")
        guess();
};


// ---- Start ---------------------------------------------------------------

const getJSON = async url => {

    const res = await fetch(url);

    if (!res.ok)
        throw new Error(
            `${url}: HTTP ${res.status}`
        );

    return res.json();
};


async function init() {

    $("in").disabled =
        $("go").disabled = true;

    $("msg").textContent =
        "Loading routes…";

    // Declared outside the try block so they can be used below
    let routeData, locs, popular;

    try {

        [
            routeData,
            locs,
            popular
        ] = await Promise.all([
            getJSON(ROUTES_URL),
            getJSON(LOCATIONS_URL),
            getJSON(POPULAR_URL)
        ]);

        locs.forEach(l =>
            coords.set(
                key(l.name),
                {
                    lat: l.latitude,
                    lng: l.longitude
                }
            )
        );

        popular.forEach((p, i) => {

            const k =
                key(
                    typeof p === "string"
                        ? p
                        : p.name
                );

            if (!rank.has(k))
                rank.set(k, i);
        });

        routes =
            loadRoutes(routeData);

        if (!routes.length)
            throw new Error(
                "No routes start in the configured cities"
            );

    } catch (err) {

        console.error(
            "Could not load game data:",
            err
        );

        $("msg").textContent =
            "Couldn't load the route data.";

        return;
    }

    // Possible answers: final stops of routes
    destinations =
        [...new Set(
            routes.map(destination)
        )].sort();

    // Guessable: every stop on any route plus every known location,
    // deduplicated by cleaned, lowercased name
    const all = new Map();

    [
        ...Object.values(routeData.routes)
            .flatMap(r => r.stopNames.map(clean)),
        ...locs.map(l => clean(l.name))
    ].forEach(name => {
        if (!all.has(key(name)))
            all.set(key(name), name);
    });

    guessable = [...all.values()].sort();

    $("dl").innerHTML =
        guessable
            .map(d =>
                `<option value="${esc(d)}">`
            )
            .join("");

    $("in").disabled =
        $("go").disabled = false;

    newGame();
}


// Start loading
init();