let logs = [];

    async function fetchLogs() {
      const response = await fetch('/api/logs');
      logs = await response.json();
      displayLogs(logs);
    }

    function displayLogs(logsToDisplay) {
      const logContainer = document.getElementById('logContainer');
      logContainer.innerHTML = ''; 

      logsToDisplay.forEach(log => {
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';

        const logRegencySerial = document.createElement('span');
        logRegencySerial.textContent = log.regencySerial;

        const logDate = document.createElement('span');
        logDate.textContent = log.date;

        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'buttons';

        const viewButton = document.createElement('button');
        viewButton.textContent = 'View';
        viewButton.onclick = () => {
          window.open(`/output/${log.filename}`, '_blank');
        };

        const downloadButton = document.createElement('button');
        downloadButton.textContent = 'Download';
        downloadButton.onclick = () => {
          window.location.href = `/output/${log.filename}`;
        };

        buttonsContainer.appendChild(viewButton);
        buttonsContainer.appendChild(downloadButton);

        logEntry.appendChild(logRegencySerial);
        logEntry.appendChild(logDate);
        logEntry.appendChild(buttonsContainer);

        logContainer.appendChild(logEntry);
      });
    }

    function searchLogs() {
      const searchTerm = document.getElementById('searchInput').value.toLowerCase();
      const filteredLogs = logs.filter(log => 
        log.regencySerial.toLowerCase().includes(searchTerm) || 
        log.date.toLowerCase().includes(searchTerm)
      );
      displayLogs(filteredLogs);
    }

    document.getElementById('searchInput').addEventListener('input', searchLogs);

    window.onload = fetchLogs;