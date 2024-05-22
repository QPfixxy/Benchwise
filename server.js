const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { gatherHardwareInfo } = require('./apps/hardwareinfo');
const ioFetch = require('./apps/IOfetch');
const logsDirectory = path.join(__dirname, 'output');

const app = express();
const port = 3000;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      cb(null, 'output/');
  },
  filename: function (req, file, cb) {
      setTimeout(() => {
          const serialNumber = req.body.serialNumber;
          if (serialNumber) {
              cb(null, `${serialNumber}.pdf`);
          } else {
              cb(new Error("Serial number not provided"));
          }
      }, 0);
  }
});

const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/hardware-info', async (req, res) => {
  try {
      const hardwareInfo = await gatherHardwareInfo();
      res.json(hardwareInfo);
  } catch (error) {
      console.error('Error fetching hardware information:', error);
      res.status(500).json({ error: 'Failed to fetch hardware information' });
  }
});
        
app.get('/iodevices', async (req, res) => {
  try {
    const ioDevices = await ioFetch.getIODevices();
    res.json(ioDevices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/logs', (req, res) => {
  fs.readdir(logsDirectory, (err, files) => {
    if (err) {
      return res.status(500).send('Unable to scan directory');
    }

    const logs = files.map(file => {
      const filePath = path.join(logsDirectory, file);
      const stats = fs.statSync(filePath);
      return {
        regencySerial: path.basename(file, path.extname(file)),
        date: stats.mtime.toISOString().split('T')[0],
        filename: file
      };
    });

    res.json(logs);
  });
});

app.use('/output', express.static(logsDirectory));

app.get('/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(logsDirectory, filename);
  res.download(filepath); 
});

app.post('/save-pdf', upload.single('pdf'), (req, res) => {
  if (!req.file) {
      return res.status(400).send({ message: 'No file uploaded' });
  }
  res.send({ message: 'File uploaded successfully', filename: req.file.filename });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  import('open').then(open => {
      open.default(`http://localhost:${port}`);
  }).catch(error => console.error("Failed to open browser:", error));
});

