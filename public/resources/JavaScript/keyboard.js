const catBlue = "#0099ff";

function allKeycap(color, textColor) {
    $(".keycap-style").css("background-color", color);
    $(".keycap-style").css("color", textColor);
}

function singleKeycap(e, color, textColor) {
    $("#" + e.code).css("background-color", color);
    $("#" + e.code).css("color", textColor);
}

$(document).keydown(function (e) {
    e.preventDefault();
    singleKeycap(e, catBlue, "black"); 
    console.log("Key: " + e.code + " Code: " + e.keyCode);
});

$(document).keyup(function (e) {
});

$("#resetButton").click(function() {
    allKeycap("", "");
});