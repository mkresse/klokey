"use strict";

var util = require('util');
var display = require('./display.js');

var queue = [];

var interval = 25;
var ticks = 0;

var debuglog = util.debuglog('anim');


var functions = {
    'towards': function(led) {
        var by = this.cur / this.length;
        var to = this.args.to[led];
        var from = this.args.from[led];
        display.PIXEL_DATA[led] =
            (this.interpolation(from[0], to[0], by) << 16) |
            (this.interpolation(from[1], to[1], by) << 8) |
            (this.interpolation(from[2], to[2], by));
    },

    'rainbow': function(cmd) {

    }
};

var interpolations = {
    'linear': function() {
        return function (from, to, by) {
            return from + (to - from) * by;
        };
    },

    'gamma': function(arg) {
        return function(from, to, by) {
            var frac = (arg >= 0) ? Math.pow(by, arg) : (1-Math.pow(by, -arg));
            return from + (to-from) * frac;
        };
    }
};

var sum = [0,0];

var tick = function() {
    var start = process.hrtime();

    if (queue.length) {
        debuglog('tick: ', ticks);
    }

    for (var i=0; i<queue.length; i++) {
        var cmd = queue[i];

        var now = Date.now();
        var time = now - cmd.start;
        cmd.cur = (time > cmd.length) ? cmd.length : time;

        debuglog('0x%s : %d / %d', Number(cmd.ledmask).toString(16), cmd.cur, cmd.length);

        for (var led=0; led < display.NUM_LEDS; led++) {
            if ((1 << led) & cmd.ledmask) {
                cmd.func(led);
            }
        }

        if (cmd.cur === cmd.length) {
            queue.splice(i, 1);
            i--;

            if (cmd.done) {
                cmd.done();
            }
        }
    }

    display.render();

    ticks++;

    var end = process.hrtime(start);
    sum[0] += end[0];
    sum[1] += end[1];

    if (ticks % 20 === 19) {
        var ms = ((sum[1] / 1000000) + sum[0] * 1000) / 20;
        //debuglog('avg tick took: ' + ms.toFixed(2) + ' ms');
        sum[0] = 0; sum[1] = 0;
    }
};

function overlay(target, bottom, top, alpha) {
    target[0] = bottom[0] + (top[0]-bottom[0]) * alpha;
    target[1] = bottom[1] + (top[1]-bottom[1]) * alpha;
    target[2] = bottom[2] + (top[2]-bottom[2]) * alpha;
}

exports.clearQueue = function() {
    queue.length = 0;
};

exports.addAmination = function(leds, from, to, time, done, gamma) {
    var fromArray = new Array(display.NUM_LEDS);
    var toArray = new Array(display.NUM_LEDS);

    var current = new Uint8Array(3);

    from = [from.r*255|0, from.g*255|0, from.b*255|0, from.a];
    to = [to.r*255|0, to.g*255|0, to.b*255|0, to.a];

    for (var led=0; led < display.NUM_LEDS; led++) {
        if ((1 << led) & leds) {
            current[0] = (display.PIXEL_DATA[led] & 0xff0000) >> 16;
            current[1] = (display.PIXEL_DATA[led] & 0x00ff00) >> 8;
            current[2] = (display.PIXEL_DATA[led] & 0x0000ff);

            fromArray[led] = new Uint8Array(3);
            toArray[led] = new Uint8Array(3);

            overlay(fromArray[led], current, from, from[3]);
            overlay(toArray[led],   current, to,   to[3]);

            //console.log('led ' + led + " cur : ", col2str(current));
            //console.log('led ' + led + " from: ", col2str(fromArray[led]) + " (rel: " + from + " a:" + from[3] + ")");
            //console.log('led ' + led + " to:   ",   col2str(toArray[led]) + " (rel: " + to + " a:" + to[3] + ")");
        }
    }

    var interpolation = (gamma && (gamma !== 1)) ? interpolations.gamma(gamma) : interpolations.linear();

    var cmd = {
        ledmask: leds,
        func: functions.towards,
        args: {
            from: fromArray,
            to: toArray
        },
        start: Date.now(),
        length: time,
        interpolation: interpolation,
        done: done,
        cur: 0
    };

    queue.push(cmd);
};

function col2str(col) {
    return col[0]+","+col[1] + "," + col[2];
}

exports.init = function(options) {
    if (options && options.interval) {
        interval = options.interval;
    }

    setInterval(tick, interval);
};

exports.RING = 0x7e;
exports.CENTER = 0x01;
