let dotsTouched = 0;

function startTest() {
  document.getElementById('touch-area').innerHTML = '';
  document.getElementById('touch-area').classList.add('full-screen');

  for (let i = 0; i < 9; i++) {
    createTouchPoint();
  }

  setTimeout(endTest, 20000);
}

function createTouchPoint() {
  const touchPoint = document.createElement('div');
  touchPoint.className = 'touch-point';
  touchPoint.style.left = `${Math.random() * (window.innerWidth - 50)}px`;
  touchPoint.style.top = `${Math.random() * (window.innerHeight - 50)}px`;
  touchPoint.addEventListener('click', function() {
    if (!touchPoint.classList.contains('blue')) {
      touchPoint.classList.add('blue');
      dotsTouched++;
      if (dotsTouched === 9) {
        setTimeout(endTest, 8000);
      }
    }
  });
  document.getElementById('touch-area').appendChild(touchPoint);
}

function endTest() {
  const testArea = document.getElementById('touch-area');
  testArea.innerHTML = '<button class="button repeat-button" onclick="repeatTest()">Repeat Test</button>';
  testArea.classList.remove('full-screen');
}

function repeatTest() {
  dotsTouched = 0;
  startTest();
}