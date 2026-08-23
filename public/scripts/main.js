var data = [
    [22, 'Working late'],
    [18, 'Good evening'],
    [12, 'Good afternoon'],
    [5,  'Good morning'],
    [0,  'Whoa, early bird']
],
hr = new Date().getHours();
for (var i = 0; i < data.length; i++) {
    if (hr >= data[i][0]) {
        console.log(data[i][1])
        break;
    }
}