// Dependencies
const express = require('express');
const path = require('path');
const { gatherHardwareInfo } = require('./apps/hardwareinfo');

const app = express();
const port = 3000;


// Public access folder for HTML
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Route to get system information
app.get('/hardware-info', async (req, res) => {
  try {
      const hardwareInfo = await gatherHardwareInfo();
      res.json(hardwareInfo);
  } catch (error) {
      console.error('Error fetching hardware information:', error);
      res.status(500).json({ error: 'Failed to fetch hardware information' });
  }
});
        
// Server Start function
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  import('open').then(open => {
      open.default(`http://localhost:${port}`);
  }).catch(error => console.error("Failed to open browser:", error));
});

//Validation (Stress Testing CPU, GPU, RAM, STORAGE)

//hardware (USB PORTS, SD PORT, DISPLAY PORTS, AUX PORTS, KEYBOARD, WEBCAM, TOUCHSCREEN)

//tools (Plwto, external audit tools, etc)

