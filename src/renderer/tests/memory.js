import { mountStress } from './stress-ui.js';

export default {
  id: 'memory',
  name: 'Memory Test',
  description:
    'Fills a large share of free RAM with seven test patterns (stuck bits, coupling, walking ones, address lines, random data), then reads everything back. Any mismatch fails the unit.',
  mount(root, ctx) {
    return mountStress(root, ctx, {
      kind: 'memory',
      intro: 'Close other apps first so more RAM can be tested. The system may feel slow during the run.',
    });
  },
};
