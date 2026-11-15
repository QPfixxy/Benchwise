import { mountStress } from './stress-ui.js';

export default {
  id: 'cpu',
  name: 'CPU Stress',
  description:
    'Loads every core with integer, floating-point, cache and SIMD work whose answers are known in advance. A single wrong answer fails the unit. Throughput is tracked to spot thermal throttling.',
  mount(root, ctx) {
    return mountStress(root, ctx, {
      kind: 'cpu',
      intro: 'Plug in the charger first. Fans spinning up is expected. Run Standard or Burn-in on units with a cooling history or a suspect power supply.',
    });
  },
};
