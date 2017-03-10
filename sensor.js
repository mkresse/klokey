"use strict";

var EventEmitter =  require('events').EventEmitter;
var SerialPort = require('serialport').SerialPort;
var GPIO = require('onoff').Gpio;
var winston = require('winston');

exports.init = function(options, logger) {
    var timerRFIDWatchdog;
    var eventEmitter = new EventEmitter();
    var serialPort = new SerialPort('/dev/ttyAMA0', {
        baudrate: 9600,
        databits: 8,
        parity: 'none',
        stopbits: 1
    });

    // delay, so events can be processed
    process.nextTick(function() {
        serialPort.on("open", function (error) {
            if (error) {
                logger.error('failed to open serial port: ' + error);

                eventEmitter.emit("error");
            } else {
                logger.info('opened serial port');

                var resetPin = new GPIO(17, 'out');
                var reset = function() {
                    resetPin.writeSync(0);
                    setTimeout(function() {
                        resetPin.writeSync(1);
                    }, 50);
                    setTimeout(reset, 3000);
                };
                reset();

                eventEmitter.emit("open");

                serialPort.on('data', function (data) {
                    if (data && data.length && data[0]) {
                        //logger.trace('serial data received: ' + data);

                        if (timerRFIDWatchdog) {
                            clearTimeout(timerRFIDWatchdog);
                        }

                        timerRFIDWatchdog = setTimeout(function() {
                            timerRFIDWatchdog = undefined;
                            eventEmitter.emit("RFIDWatchdogExpired");
                        }, options.RFID_WATCHDOG_TIMEOUT);

                        eventEmitter.emit("RFIDDataReceived");
                    }
                });
            }
        });
    });

    return eventEmitter;
};
