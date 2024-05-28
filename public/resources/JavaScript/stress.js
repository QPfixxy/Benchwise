
var selectedTests = [];
var currentIndex = 0;

function startTest() {
    selectedTests = [];
    currentIndex = 0;
    resetProgressBar();
    var checkboxes = document.querySelectorAll('.test-selection input[type="checkbox"]');
    checkboxes.forEach(function(checkbox) {
        if (checkbox.checked) {
            selectedTests.push(checkbox.value);
        }
    });
    runNextTest();
}

function testAll() {
    selectedTests = ['cpu', 'gpu', 'ram', 'Storage'];
    currentIndex = 0;
    resetProgressBar();
    runNextTest();
}

function resetProgressBar() {
    var progressBar = document.getElementById('testProgressBar');
    var progressText = document.getElementById('testProgressText');
    progressBar.value = 0;
    progressText.textContent = '0/0 tests completed';
}

function runNextTest() {
    if (currentIndex < selectedTests.length) {
        var testName = selectedTests[currentIndex];
        runTest(testName);
    } else {
        updateProgressBar();
    }
}

function runTest(testName) {
    var testResultElement = document.getElementById(testName + 'TestResult');
    testResultElement.textContent = testName + ' is running...';
    // Simulate test completion after 2 seconds
    setTimeout(function() {
        var testPassed = Math.random() < 0.5; // Simulate test completion after 2 seconds
        if (testPassed) {
            testResultElement.textContent = testName + ' passed.';
            testResultElement.classList.remove('test-not-run');
            testResultElement.classList.remove('test-fail');
            testResultElement.classList.add('test-pass');
        } else {
            testResultElement.textContent = testName + ' failed.';
            testResultElement.classList.remove('test-not-run');
            testResultElement.classList.remove('test-pass');
            testResultElement.classList.add('test-fail');
        }
        currentIndex++;
        updateProgressBar(); 
        runNextTest(); 
    }, 2000);
}

function updateProgressBar() {
    var progressBar = document.getElementById('testProgressBar');
    var progressText = document.getElementById('testProgressText');
    progressBar.value = currentIndex;
    progressText.textContent = currentIndex + '/' + selectedTests.length + ' tests completed';
}