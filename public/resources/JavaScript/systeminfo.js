      document.addEventListener('DOMContentLoaded', function() {
        getHardwareInfo();
      });
  
      function generateQRCode(text) {
        var qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return qr.createImgTag();
      }
  
      function getHardwareInfo() {
        fetch('/hardware-info')
          .then(response => response.json())
          .then(data => {
            displayHardwareInfo(data);
          })
          .catch(error => {
            console.error('Error fetching hardware information:', error.message);
            displayError();
          });
      }
  
      function displayHardwareInfo(data) {
        document.getElementById('systemInfoSection').innerHTML = `
          <tr>
            <th>System Information</th>
            <td>Make: ${data.manufacturer}</td>
            <td>Model: ${data.model}</td>
            <td>Serial Number: ${data.systemSerialNumber}</td>
            <td class="qr-code">${generateQRCode(data.systemSerialNumber)}</td>
          </tr>
        `;
  
        document.getElementById('cpuInfoSection').innerHTML = `
          <tr>
            <th>CPU Information</th>
            <td colspan="3">Model: ${data.cpuModel}, Speed: ${data.cpuSpeed} MHz, Cores: ${data.cpuCores}</td>
            <td></td>
          </tr>
        `;
  
        document.getElementById('ramInfoSection').innerHTML = `
          <tr>
            <th>RAM Information</th>
            <td colspan="3">Total Memory: ${(data.totalMemory / Math.pow(1024, 3)).toFixed(2)} GB, RAM Type: ${data.ramType}, RAM Technology: ${data.ramTechnology}</td>
            <td></td>
          </tr>
        `;
  
        document.getElementById('batteryInfoSection').innerHTML = `
          <tr>
            <th>Battery Information</th>
            <td colspan="3">Charge State: ${data.batteryChargeState}, Battery Health: ${data.batteryHealth}, Average Charging Voltage: ${data.batteryChargingVoltage} volts</td>
            <td></td>
          </tr>
        `;
  
        document.getElementById('webcamInfoSection').innerHTML = `
          <tr>
            <th>Webcam Information</th>
            <td colspan="3">${data.webcam}</td>
            <td></td>
          </tr>
        `;
  
        document.getElementById('speakerInfoSection').innerHTML = `
          <tr>
            <th>Speaker Information</th>
            <td colspan="3">${data.speaker}</td>
            <td></td>
          </tr>
        `;
  
        document.getElementById('microphoneInfoSection').innerHTML = `
          <tr>
            <th>Microphone Information</th>
            <td colspan="3">${data.microphone}</td>
            <td></td>
          </tr>
        `;
  
        const hardDriveInfoSection = document.getElementById('hardDriveInfoSection');
        hardDriveInfoSection.innerHTML = '';
        data.hardDrives.forEach((drive, index) => {
          hardDriveInfoSection.innerHTML += `
            <tr>
              <th>Hard Drive ${index + 1} Information</th>
              <td>Model: ${drive.modelName}</td>
              <td>Capacity: ${(drive.totalCapacity)} GB</td>
              <td>Serial Number: ${drive.serialNumber}</td>
              <td class="qr-code">${generateQRCode(drive.serialNumber)}</td>
            </tr>
          `;
        });
  
        const systemSerialNumberElement = document.getElementById('systemSerialNumber');
        if (systemSerialNumberElement.innerHTML === '') {
          const laptopSerialQR = generateQRCode(data.systemSerialNumber);
          systemSerialNumberElement.innerHTML = laptopSerialQR;
        }
      }
  
      function displayError() {
        const hardwareTable = document.getElementById('hardwareTable');
        hardwareTable.innerHTML = `
          <tr>
            <td colspan="5">Error fetching hardware information. Please try again later.</td>
          </tr>
        `;
      }