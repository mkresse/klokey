# KloKey

## What?

A watchdog, reservation and notification system for the office toilet key.

And my first experiments in nodejs.


## Features

* Watchdog for lost or forgotten key
* Broadcast in case of lost key via:
  * Browser notification (web socket)
  * Hipchat integration
  * Email
* Remote status query
* Reservation with waiting queue and notification
* API via web socket, HTTP and MQTT
* GDPR compliant


## But Why?

Klokey aims at the solution of the dreaded toilet-key-forgotten-in-pants-pocket- (and-possibly-taken-home-) problem.
Additionally, it provides some convenient features like remote query for availability, reservation and Hipchat integration.


## How?

- based on a Raspberry Pi with attached RFID reader RDM630
- a reset line added to the reader circuit in order to detect token removal
- a WS2812 based led ring to indicate current status
- a 125kHz RFID token attached to the key
- a nodejs based server that queries the current token state, checks for timeout, manages reservations and notifies clients


## Where?

https://klokey.espresto.com


## MQTT Support

you can enable mqtt publishing in the config. you can pass any mqtt options (https://www.npmjs.com/package/mqtt#client) via the options field:

    "mqtt": {
        "enable": true,
        "host": "127.0.0.1",
        "port": "1883",
        "topic": "klokey",
        "options": {
          "username": "user",
          "password": "secret"
        }
    },
    
these events will be published to the following subtopics:

    /(subtopic name)
        (event name) - (description)
    /server
        STARTED - klokey server started
        STATE   - /state route is called
        TEST    - /test route is called
        SWITCH  - /switch route is called
    /queue
        ENQUEUE - somebody put herself to the queue
        LEAVE   - somebody left the queue
        EXPIRED - qeue expired
    /event
        TAKEN   - key taken
        RETURNED - key returned
        MISSING - key is missing
        MAIL    - key missing mail was send
    /client
        CONNECT - websocket client connected
        CLOSE   - websocket client closed
        DISCONNECT - websocket client disconnected
    /state
        - JSON representation of current state (persistent)
