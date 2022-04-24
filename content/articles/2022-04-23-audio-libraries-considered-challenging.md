+++
title = "Audio Libraries Considered Challenging"
date = 2022-04-23
+++

The main reason audio is difficult: it runs at ~48,000 FPS

It's very important that audio stays running at a consistent FPS [example of
what happens if it doesn't]

Main implications:

- Audio has to run on a different thread, which creates challenges on its own
- Cannot allocate memory or block on the audio thread

## Threading challenges

- Cannot directly interact with things on a different thread, so you have to use
  message passing
- You need a unique identifier for things you want to control
- How do you create the unique identifier? Possible options:
  - Create the unique identifier on the non-realtime thread, use hashmaps on the
    audio thread
    - Problems:
      - Hashmaps lose capacity over time
      - Hashing is slow:tm:
  - Use an arena, wait for the arena to send back a new ID
    - Problem: way too slow
  - Don't use identifiers at all, just keep pointers to the objects you want to
    control
    - Problems:
      - Now you have to operate everything via atomics, since mutexes are out -
        limits the kind of data you can use
      - Can be hard to track allocatons and make sure they're all deallocated on
        the non-realtime thread

Current solution: atomic arena
