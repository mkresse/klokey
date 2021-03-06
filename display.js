/**
 * Created by martin on 15.07.2015.
 */

"use strict";

var ws281x;
var winston = require('winston');

var NUM_LEDS = 7,
    logger,
    outputBuffer = new Uint32Array(NUM_LEDS),
    pixelData = new Uint32Array(NUM_LEDS);


exports.NUM_LEDS = NUM_LEDS;

exports.PIXEL_DATA = pixelData;

exports.render = function() {
    if (ws281x) {
        outputBuffer.set(pixelData);
        ws281x.render(outputBuffer);
    }
};

exports.init = function(serverLogger) {
    logger = serverLogger || winston;

    ws281x = require('rpi-ws281x-native');

    if (ws281x) {
        logger.info("********* Initializing display *********");

        ws281x.init(NUM_LEDS);
    } else {
        logger.warn("********* Display not available *********");

    }

    // ---- trap the SIGINT and reset before exit
    process.on('SIGINT', function () {
        ws281x.reset();
        process.nextTick(function () { process.exit(0); });
    });

    //pixelData[0] = 0xffffff;
    exports.render();
};

exports.color = function(value, led) {
    pixelData[led | 0] = value;
    if (ws281x) {
        outputBuffer.set(pixelData);
        ws281x.render(outputBuffer);
    }
};