/**
 * Created by martin on 15.07.2015.
 */

"use strict";

var ws281x = require('rpi-ws281x-native');

var NUM_LEDS = 7,
    pixelData = new Uint32Array(NUM_LEDS);


exports.init = function() {
    console.log("********* Initializing display *********");

    ws281x.init(NUM_LEDS);

    // ---- trap the SIGINT and reset before exit
    process.on('SIGINT', function () {
        ws281x.reset();
        process.nextTick(function () { process.exit(0); });
    });

    pixelData[0] = 0xffffff;
    ws281x.render(pixelData);
};

exports.color = function(value) {
    pixelData[0] = value;
    ws281x.render(pixelData);
};