document.addEventListener('DOMContentLoaded', () => {
    resetStatusBar();
    setupEventListeners();
  });
  
  function setupEventListeners() {
    document.getElementById('record-button').addEventListener('click', startRecording);
    document.getElementById('play-button').addEventListener('click', playRecording);
  }
  
  let mediaRecorder;
  let audioChunks = [];
  let isRecording = false;
  let audioContext, source, analyser, bufferLength, dataArray;
  
  function startRecording() {
    if (!isRecording) {
      isRecording = true;
      document.getElementById('record-button').textContent = 'Stop';
      document.getElementById('play-button').disabled = true;
      audioChunks = [];
  
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          mediaRecorder = new MediaRecorder(stream);
          mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
          };
  
          mediaRecorder.onstop = finalizeRecording;
          mediaRecorder.start();
          setupAudioProcessing(stream);
  
          setTimeout(() => {
            if (isRecording) {
              stopRecording();
            }
          }, 10000); //timer
        })
        .catch(error => console.error('Error accessing audio stream:', error));
    } else {
      stopRecording();
    }
  }
  
  function stopRecording() {
    if (isRecording) {  
      mediaRecorder.stop();
      document.getElementById('record-button').textContent = 'Record';
      isRecording = false;
    }
  }
  
  function setupAudioProcessing(stream) {
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    source.connect(analyser);
    updateAudioVisuals();
  }
  
  function updateAudioVisuals() {
    if (!isRecording) return;
    requestAnimationFrame(updateAudioVisuals);
    analyser.getByteTimeDomainData(dataArray);
  
    let sum = 0;
    let max = 0;
    for (let i = 0; i < bufferLength; i++) {
      let value = dataArray[i] - 128;
      sum += Math.abs(value);
      max = Math.max(max, Math.abs(value));
    }
    let average = sum / bufferLength;
    const statusBar = document.getElementById('status-bar');
    statusBar.style.backgroundColor = average < 2 ? 'gray' : max > 60 ? 'red' : 'green';
  }
  
  function finalizeRecording() {
    const audioBlob = new Blob(audioChunks);
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = document.getElementById('audio-playback');
    audio.src = audioUrl;
    document.getElementById('play-button').disabled = false;
    resetStatusBar();
    source.disconnect();
    analyser.disconnect();
    audioContext.close();
  }
  
  function stopRecording() {
    mediaRecorder.stop();
    document.getElementById('record-button').textContent = 'Record';
    isRecording = false;
  }
  
  function playRecording() {
    const audio = document.getElementById('audio-playback');
    audio.play();
  }
  
  function resetStatusBar() {
    const statusBar = document.getElementById('status-bar');
    statusBar.style.backgroundColor = 'gray';
  }
  
  document.addEventListener('DOMContentLoaded', function() {
    const audioElement = document.createElement('audio');
    audioElement.src = '../resources/audio.m4a'; 
    let isPlaying = false;
  
    const testButton = document.getElementById('test-speaker-button');
    const progressBar = document.getElementById('progress-bar');
    
    testButton.addEventListener('click', () => {
      if (!isPlaying) {
        audioElement.play().catch(error => console.error('Error playing test sound:', error));
        testButton.textContent = 'Stop Test';
        isPlaying = true;
      } else {
        audioElement.pause();
        audioElement.currentTime = 0;
        testButton.textContent = 'Test Speakers';
        isPlaying = false;
        progressBar.style.width = '0%'; 
      }
    });
  
    audioElement.addEventListener('timeupdate', () => {
      const progress = (audioElement.currentTime / audioElement.duration) * 100;
      progressBar.style.width = `${progress}%`;
    });
  
    audioElement.addEventListener('ended', () => {
      testButton.textContent = 'Test Speakers';
      isPlaying = false;
      progressBar.style.width = '0%'; 
    });
  });