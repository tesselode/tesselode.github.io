+++
title = "Audio Libraries Considered Challenging"
date = 2022-04-23
+++

I develop a game audio library called
[Kira](https://github.com/tesselode/kira/). Here's some of the challenges I've
faced.

## Why Audio is Hard

Graphics usually update at somewhere between 60 and 500 frames per second. If
the framerate drops below the monitor's refresh rate, you'll continue to see the
last rendered frame until the next frame is ready. If it's a small frame drop,
you might not even notice.

**Audio runs at about 48,000 frames per second.** And if there's a frame drop
(in audio this is called a buffer underrun), you'll notice.

[example of audio with stuttering]

When writing audio code, you want to avoid underruns at all costs. This means
**you have to do your audio processing on a separate thread.** If you tried to
do audio processing on the same thread as your graphics and input, your audio
would stutter when the graphics rendering becomes too demanding.

**You also can't block the audio thread.** If something could cause the audio
thread to pause for an unknown amount of time, you shouldn't do it. If the audio
thread pauses for too long, it won't be able to process audio fast enough,
leading to buffer underruns.

Notably, this means **you can't allocate or deallocate memory on the audio
thread**. When you ask the operating system to allocate or deallocate memory,
you have to pause the thread until the OS is ready to get around to your
request. Usually it'll do it quickly, but if the system is taxed, the OS might
deprioritize the audio thread, leading to a long period where you can't process
any audio.

<aside>
This isn't something I know from experience. By its nature, this is a problem that
doesn't come up very frequently. I'm taking the word of other people who do audio
programming.
</aside>

Keeping these two constraints in mind, let's look at some problems that come up
when creating a game audio library.

<aside>
The code examples will be in Rust, since that's what Kira is written in. The same
principles will apply in C and C++.
</aside>

## Communicating Between Threads

A game audio library provides functions for playing and modifying audio that you
can call from gameplay code. It'll look vaguely like this:

```rust
let mut sound_handle = audio.play("sound.mp3");
/// later...
sound_handle.set_volume(0.5);
```

When we play a new sound, we need to load audio data from a file on the gameplay
thread and send it to the audio thread. (We can't load the audio data on the
audio thread because that takes too long and could lead to buffer underruns.) To
send the audio data to the audio thread, we can use a ringbuffer, such as the
[`ringbuf`](https://crates.io/crates/ringbuf) crate.

```rust
// on the gameplay thread
audio_producer.push(audio_data);
// on the audio thread
while let Some(audio_data) = audio_consumer.pop() {
  play_audio(audio_data);
}
```

But how do we tell the audio thread to modify an existing sound (e.g. setting
the volume of a sound that's already playing or setting the playback state of a
sound)?

### Shared ownership via `Mutex`es

We could allow the gameplay thread to control data on the audio thread directly
by giving it shared ownership of the data via a `Mutex`.

On the audio thread, we'll store the sound state as an `Arc<Mutex<Sound>>`. Our
sound handle on the gameplay thread will have a clone of that
`Arc<Mutex<Sound>>`:

```rust
struct SoundHandle {
  playback_state: PlaybackState,
  sound: Arc<Mutex<Sound>>,
}
```

To access audio data on the gameplay thread, we just have to lock the `Mutex`:

```rust
impl SoundHandle {
  pub fn set_playback_state(&self, playback_state: PlaybackState) {
    sound.lock().unwrap().playback_state = playback_state;
  }

  pub fn set_volume(&self, volume: f32) {
    sound.lock().unwrap().volume = volume;
  }
}
```

Of course, the audio thread also has to lock the data before it can access it.
Waiting for other threads to unlock the data does, in fact, block the audio
thread, which is one of the things we definitely shouldn't do. So `Mutex`es are
out.

### Shared ownership via atomics

There is a way we can share data among multiple threads without having to lock
it: atomics. Atomics are special versions of primitive types that the CPU knows
how to keep synchronized between threads.

We can make each modifiable field of the sound atomic:

```rust
struct Sound {
  playback_state: Arc<AtomicU8>,
  volume: Arc<AtomicU32>,
}
```

The sound handle will get clones of each field:

```rust
struct SoundHandle {
  playback_state: Arc<AtomicU8>,
  volume: Arc<AtomicU32>,
}
```

And to set those fields from the gameplay thread:

```rust
impl SoundHandle {
  pub fn set_playback_state(&self, playback_state: PlaybackState) {
    self.playback_state.store(playback_state as u8, Ordering::SeqCst);
  }

  pub fn set_volume(&self, volume: f32) {
    self.volume.store(volume.to_bits(), Ordering::SeqCst);
  }
}
```

Using atomics won't block the audio thread, but it does have some limitations.
The largest atomic is 64 bits. That's enough space for a volume level or a
playback state, but what if we want to send a more complex command to the audio
thread? For example, what if we want to smoothly adjust the volume of a sound
over a period of time? Maybe even with a user-specified easing curve?

If we represented all the needed information for that command as a struct, it
would look something like this:

```rust
struct VolumeChange {
  volume: f32, // 32 bits
  duration: Duration, // 96 bits
  easing: Easing, // 8 bits is probably enough
}
```

That's more than we can fit in one atomic. We could store the command in
multiple atomics, but then we have to keep them synced up. If we limited the
maximum duration, maybe we could store it in 16 bits. I'm sure this is a
solvable problem, but the solution won't be very ergonomic. So what else can we
do?

### Use more ringbuffers

Why not just send commands via a ringbuffer? We're already using them for
sending audio data.

We can describe all of the possible commands with an enum:

```rust
enum SoundCommand {
  SetPlaybackState(PlaybackState),
  SetVolume(f32),
}
```

The sound handle will own a command producer that it can push to:

```rust
struct SoundHandle {
  command_producer: Producer<SoundCommand>,
}

impl SoundHandle {
  pub fn set_playback_state(&self, playback_state: PlaybackState) {
    self.command_producer.push(SoundCommand::SetPlaybackState(playback_state));
  }

  pub fn set_volume(&self, volume: f32) {
    self.command_producer.push(SoundCommand::SetVolume(volume));
  }
}
```

And the audio thread will own a command consumer that it can pop from:

```rust
struct Sound {
  playback_rate: PlaybackRate,
  volume: f32,
  command_consumer: Consumer<SoundCommand>,
}

impl Sound {
  // called periodically
  pub fn update(&mut self) {
    while let Some(command) = self.command_consumer.pop() {
      match command {
        SoundCommand::SetPlaybackRate(playback_rate) => {
          self.playback_rate = playback_rate;
        }
        SoundCommand::SetVolume(volume) => {
          self.volume = volume;
        }
      }
    }
  }
}
```

There is a downside to this approach: every sound has to periodically poll for
new commands. Most sounds will not be changed at any one time, so it seems
wasteful that they all have to poll for commands. (And in my unscientific
benchmarking, all of the polling does make a noticeable difference in
performance.)

Maybe we can just use one ringbuffer to collect the commands for every sound? We
already have a ringbuffer for sending audio data, so let's just expand that to
send a command enum:

```rust
Command {
  PlaySound(AudioData),
  SetSoundPlaybackRate(PlaybackRate),
  SetSoundVolume(f32),
}
```

Of course, we need a way to tell the audio thread which sound we want to change,
so let's add some unique identifiers to those commands.

```rust
Command {
  PlaySound(AudioData),
  SetSoundPlaybackRate(SoundId, PlaybackRate),
  SetSoundVolume(SoundId, f32),
}
```

Every sound handle will need the ID of the sound it's meant to control. Also,
every sound handle will need to push commands to the same command producer, so
we'll need to wrap it in a `Mutex`:

```rust
struct SoundHandle {
  sound_id: SoundId,
  command_producer: Arc<Mutex<Producer<Command>>>,
}
```

Unlike the last time we tried using `Mutex`es, this `Mutex` is only shared on
the gameplay thread, so there's no risk of blocking the audio thread.

On the audio thread, we'll have some code along these lines:

```rust
while let Some(command) = command_consumer.pop() {
  match command {
    Command::PlaySound(audio_data) => play_sound(audio_data),
    Command::SetSoundPlaybackState(sound_id, playback_state) => {
      if let Some(sound) = get_sound_by_id(sound_id) {
        sound.playback_state = playback_state;
      }
    }
    Command::SetSoundVolume(sound_id, volume) => {
      if let Some(sound) = get_sound_by_id(sound_id) {
        sound.volume = volume;
      }
    }
  }
}
```

This works! It's reasonably efficient, and we can send arbitrarily complex
commands to the audio thread without blocking anything.

There's only one problem: where does the `SoundId` come from?

## Storing Resources on the Audio Thread

---

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
