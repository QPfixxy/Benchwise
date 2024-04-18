// Dependencies
const express = require('express');
const path = require('path');
const getSystemInfo = require('./apps/hardwareinfo');

const app = express();
const port = 3000;


// Public access folder for HTML
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Route to get system information
app.get('/system-info', async (req, res) => {
  try {
    const systemInfo = await getSystemInfo();
    res.json(systemInfo);
  } catch (error) {
    console.error('Error fetching system information:', error);
    res.status(500).json({ error: 'Failed to fetch system information' });
  }
});
        
// Server Start function
app.listen(port, () => {
  console.log(`Qudit started on http://localhost:${port}`);
});

//Validation (Stress Testing CPU, GPU, RAM, STORAGE)

//hardware (USB PORTS, SD PORT, DISPLAY PORTS, AUX PORTS, KEYBOARD, WEBCAM, TOUCHSCREEN)

//tools (Plwto, external audit tools, etc)

