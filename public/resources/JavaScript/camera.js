document.addEventListener('DOMContentLoaded', () => {
    switchTest('Camera'); // Initialize page
  });
  
  document.querySelectorAll('.test-nav button[data-target]').forEach(button => {
    button.addEventListener('click', function() {
      switchTest(this.getAttribute('data-target'));
    });
  });
  
  function switchTest(testId) {
    document.querySelectorAll('.test-content').forEach(content => content.style.display = 'none');
    
    const target = document.getElementById(testId);
    target.style.display = 'block';
    
    document.querySelectorAll('.test-nav button').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-target') === testId);
    });
  }
  
  function navigateTests(direction) {
    const currentActive = document.querySelector('.test-nav button.active');
    const tests = Array.from(document.querySelectorAll('.test-nav button[data-target]'));
    let currentIndex = tests.indexOf(currentActive);
    currentIndex += direction;
  
    if (currentIndex >= tests.length) currentIndex = 0;
    if (currentIndex < 0) currentIndex = tests.length - 1;
  
    switchTest(tests[currentIndex].getAttribute('data-target'));
  }
  
  document.addEventListener('DOMContentLoaded', () => {
    switchTest('Camera'); 
    setupWebcam(); 
  });
  
  function setupWebcam() {
    const video = document.getElementById('video');
    const toggleButton = document.getElementById('toggle-button');
    const cameraSelect = document.getElementById('camera-select');
  
    async function startVideoStream(deviceId) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId } });
        video.srcObject = stream;
      } catch (error) {
        console.error('Error accessing video stream:', error);
      }
    }
  
    navigator.mediaDevices.enumerateDevices()
      .then(devices => {
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        videoDevices.forEach(device => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.text = device.label || `Camera ${cameraSelect.options.length + 1}`;
          cameraSelect.appendChild(option);
        });
        if (videoDevices.length > 0) {
          startVideoStream(videoDevices[0].deviceId); 
        }
      })
      .catch(error => {
        console.error('Error enumerating devices:', error);
      });
  
    let isCameraOn = true;
    toggleButton.addEventListener('click', () => {
      if (isCameraOn) {
        video.srcObject.getTracks().forEach(track => track.stop());
        toggleButton.textContent = 'Turn Camera On';
      } else {
        const selectedDeviceId = cameraSelect.value;
        startVideoStream(selectedDeviceId);
        toggleButton.textContent = 'Turn Camera Off';
      }
      isCameraOn = !isCameraOn;
    });
  }