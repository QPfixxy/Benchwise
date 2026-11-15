import camera from './camera.js';
import microphone from './microphone.js';
import speakers from './speakers.js';
import keyboard from './keyboard.js';
import display from './display.js';
import touchscreen from './touchscreen.js';
import ports from './ports.js';
import cpu from './cpu.js';
import memory from './memory.js';

// Order here is the order the operator walks through them. Stress tests are
// last; they can also be started first and left running during the others.
export const TESTS = [display, keyboard, touchscreen, camera, microphone, speakers, ports, cpu, memory];
