const map = L.map('locations-map');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);


// =========================================================
// Map panes
// =========================================================

// Routes sit underneath the stop markers
map.createPane('routes');
map.getPane('routes').style.zIndex = 400;

// Stop markers sit above the routes
map.createPane('stops');
map.getPane('stops').style.zIndex = 600;


// Default view until a game starts
map.setView([56.8, -4.2], 7);


// =========================================================
// Marker styles
// =========================================================

// Marker look, like Ember's map: a white outline around
// a coloured centre.
const STOP_STYLE = {
    radius: 4,
    color: '#fff',
    weight: 1.5,
    fillColor: '#222',
    fillOpacity: 1,
    pane: 'stops'
};

// Start/end stops
const ENDPOINT_STYLE = {
    ...STOP_STYLE,
    radius: 6,
    fillColor: 'rgb(59,137,108)'
};


// =========================================================
// Start marker
// =========================================================

// Called by game.js whenever a new route is chosen
let startMarker = null;

window.focusStart = city => {

    if (startMarker) {
        startMarker.remove();
    }

    const latlng = [city.lat, city.lng];

    startMarker = L.circleMarker(
        latlng,
        ENDPOINT_STYLE
    )
    .addTo(map);

    startMarker.bringToFront();

    map.setView(latlng, 9);
};


// =========================================================
// Stop markers
// =========================================================

fetch('json/ember_locations_detailed.json')
    .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    })
    .then(locations => {

        locations.forEach(loc => {

            L.circleMarker(
                [loc.latitude, loc.longitude],
                STOP_STYLE
            )
            .bindPopup(loc.name)
            .addTo(map);
        });

        // Make sure the start marker remains above
        // the newly loaded stop markers.
        if (startMarker) {
            startMarker.bringToFront();
        }
    })
    .catch(err =>
        console.error(
            'Could not load ember_locations_detailed.json:',
            err
        )
    );


// =========================================================
// Road-following Ember routes
// =========================================================

fetch('json/ember_routes_osrm.json')
    .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    })
    .then(data => {

        Object.entries(data.routes).forEach(
            ([routeName, route]) => {

                if (!route.geometry) {
                    console.warn(
                        'No geometry for:',
                        routeName
                    );
                    return;
                }

                // OSRM uses [longitude, latitude]
                // Leaflet uses [latitude, longitude]
                const coordinates =
                    route.geometry.coordinates.map(
                        coord => [coord[1], coord[0]]
                    );

                L.polyline(
                    coordinates,
                    {
                        color: 'rgb(59,137,108)',
                        weight: 3,
                        opacity: 0.8,
                        pane: 'routes'
                    }
                )
                .bindPopup(routeName)
                .addTo(map);
            }
        );
    })
    .catch(err =>
        console.error(
            'Could not load ember_routes_osrm.json:',
            err
        )
    );