"use strict";

var mqtt = require('mqtt');
var _ = require('underscore');
var client;
var topic;
var logger;

exports.init = function(options, logs) {
    logger = logs;
    if (! options || ! options.enable) {logger.info('publisher disabled'); return}

    // setting some defaults
    _.extend({
        host: '127.0.0.1',
        port: '1883',
        topic: 'klokey',
        options: {}
    }, options);

    client = mqtt.connect('mqtt://' + options.host + ':' + options.port, options.options);

    client.on('error', function (err) {
       logger.error('publisher', err.message);
    }).on('connect', function () {
        logger.info('publisher initialized');
    });

    topic = options.topic;
};

exports.publish = function(message, topicPostfix) {
    if (! client) {return}
    if (typeof topicPostfix === 'undefined') { topicPostfix = ''; }
    client.publish(topic + topicPostfix, message);
};
