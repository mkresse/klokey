# KloKey

awesome stuff and more...

## mqtt support

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
