+++
title = "Audio Libraries Considered Challenging"
date = 2022-04-23
+++

I develop a game audio library called
[Kira](https://github.com/tesselode/kira/). Here's some of the hard parts I've
figured out. If you decide to make an audio library for some reason, learn from
my experimentation!

<aside>
Note: this article uses Rust terminology and code snippets, since that's what Kira is written in, but the same principles will apply in C and C++.
</aside>

## Why Audio is Hard

Graphics usually update at somewhere between 60 and 500 frames per second. If
the framerate drops below the monitor's refresh rate, you'll continue to see the
last rendered frame until the next frame is ready. If it's a small frame drop,
you might not even notice.

**Audio runs at about 48,000 frames per second.** And if there's a frame drop
(in audio this is called a buffer underrun), you'll notice.

<figure>
  <audio controls src="normal playback example.ogg"></audio>
  <figcaption>
    A short piece of music playing back normally
  </figcaption>
</figure>

<figure>
  <audio controls src="underrun example.ogg"></audio>
  <figcaption>
    A short piece of music playing back with underruns
  </figcaption>
</figure>

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
    self.command_producer.push(
      SoundCommand::SetPlaybackState(playback_state),
    );
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

We need to store resources (sounds, mixer tracks, etc.) on the audio thread in a
way that provides:

- Fast iteration
- Fast random access to resources via an ID that the gameplay thread also has
  access to

### Solution 1: Arenas

The arena data structure is a natural fit. An arena is essentially a `Vec` of
slots that can be occupied or empty. When we insert an item into the arena, the
arena picks an empty slot to insert the item into and returns a key that
contains the index of that slot. Accessing individual items is as fast as
indexing into a `Vec`. Iterating over items is slow if you do it the naive way,
but you can use a linked list to make iteration much faster.

So this will be the flow of sending resources to the audio thread:

1. The user calls a function in the library to send a resource to the audio
   thread
2. The library sends a command to the audio thread with the resource to add and
   waits for the audio thread to send back the key
3. Next time the audio thread starts processing, it receives the command to add
   the resource, adds it to the arena, and sends back the key through a separate
   ringbuffer
4. Next time the gameplay thread checks for the key, it receives it and returns
   it to the user

So we'll have to wait a bit for the audio thread to return the key, but it
shouldn't take too long, right?

...right?

#### Why it takes too long

When you hear audio coming from speakers, you're hearing an analog
representation of digital samples that are evenly distributed over time. But an
application does not produce those digital samples at a constant rate. If it
did, then if any of the samples took too long to calculate, the application
would fall behind and wouldn't be able to produce audio fast enough, leading to
underruns. Instead, the operating system periodically asks the application to
produce a batch of samples at a time.

Let's say the operating system wants to output audio at 48,000 Hz (or samples
per second), and it requests 512 samples at a time. The audio thread will
produce 512 samples of audio, then sleep until the operating system wakes it up
for the next batch of samples. The operating system might not need to wake it up
for another 10 milliseconds, since that's the amount of audio it has queued up.

If the gameplay thread sends a command to play a sound right after the audio
thread falls asleep, the audio thread won't receive it and send back the sound
ID until 10ms later. To put that into perspective, in a 60 FPS game, 10ms is
more than half a frame. So if we played two sounds in a row, blocking the
gameplay thread each time to wait for the audio thread to send back a sound ID,
we could end up with a frame drop. That's not acceptable performance for an
audio library.

So arenas are out.

### Solution 2: `IndexMap`

If we store resources in a hash map, we can create keys on the gameplay thread
and just send them to the audio thread along with the command to add a resource.
The standard library's `HashMap` isn't very quick to iterate over, but the
[`indexmap`](https://crates.io/crates/indexmap) crate solves that problem for
us.

Here's the new flow:

1. The user calls a function in the library to send a resource to the audio
   thread
2. The library increments an ID internally to use as the key for the resource
3. The library sends a command to the audio thread to add the resource with the
   ID
4. The library immediately returns the ID to the caller

Problem solved! We don't have to wait for the audio thread to send back an ID.

There are some downsides to this approach, though:

- Hash maps are slower to get items from than arenas, because they have to hash
  the key to get the location of the item in memory
- `IndexMap`s lose capacity over time...wait, what?

If you're like me, you'd be surprised to learn the latter fact. But I'll prove
it to you!

```rust
use indexmap::IndexMap;

fn main() {
  let mut map = IndexMap::with_capacity(10);
  for i in 0..1000 {
    map.insert(i, i);
    println!("{} / {}", map.len(), map.capacity());
    if i % 5 == 0 {
      map.swap_remove_index(i / 2);
      map.swap_remove_index(i / 3);
      map.swap_remove_index(i / 4);
    }
  }
}
```

Here's a small example where I add items to an `IndexMap`. Every 5 items added,
I remove 3 items at arbitrary indices. Every time I add an item, I print the
length and total capacity of the map. You can run this code snippet yourself
[here](https://play.rust-lang.org/?version=stable&mode=debug&edition=2021&gist=a163cd12ab67bf774d0a9adef9187419).

We end up with a result something like this:

```
28 / 28
26 / 26 // capacity decreases
27 / 27
28 / 28
29 / 56
30 / 56
```

Notice the dip from a capacity of 28 to a capacity of 26? This isn't a bug,
[it's just how the hashbrown algorithm works](https://github.com/bluss/indexmap/issues/183)
(which both `IndexMap` and the standard library's `HashMap` use).

It turns out there is a workaround: the capacity will never decrease if you
don't exceed 50% of the capacity. So we could just allocate twice as much space
as we need to avoid the problem. Kira v0.5 uses this approach, but I didn't feel
comfortable relying on an unspoken implementation detail of a library.

<aside>
To be clear, I don't fault anybody for implementing a hash map in a way that results in the capacity decreasing. In almost all cases, allocating memory is perfectly fine. Just not this one!
</aside>

### Solution 3: Revisiting arenas

Maybe an arena can work; it would just need to let us generate new keys from the
gameplay thread. A suggestion from the Rust Audio discord got me thinking about
how atomics could be used to serve this purpose. I eventually came up with an
arena that has two components:

- The arena itself, which holds the resource data and lives on the audio thread
- An arena controller, which tracks free and empty slots and can generate keys.
  The controller can be cloned and sent to other threads.

When we want to add an item to an arena, we first reserve a key from the arena
controller. If too many keys have been reserved, the controller will tell us the
arena is full and not give us a key. If there are slots available, we can send
the key along with the command to add an item and return the key immediately to
the caller.

I find this to be a really elegant solution, since it solves multiple problems
at once:

- The backing data store is a `Vec`, so there won't be any surprises with the
  capacity
- Looking up resources is fast, since the keys are just indices into the `Vec`
- We can generate new keys direcly from the gameplay thread
- It's easy to get information on the number of allocated resources and
  remaining capacity from the gameplay thread

This is the solution I'm using for Kira v0.6. You can see my implementation of
the arena [here](https://crates.io/crates/atomic-arena).

## Conclusion

Making audio libraries is hard.
