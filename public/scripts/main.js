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

const addUserPopup = document.getElementById("addUserPopup");
const openAddUserPopup = document.getElementById("openAddUserPopup");
const closeAddUserPopup = document.getElementById("closeAddUserPopup");

// Update button opens a modal dialog
openAddUserPopup.addEventListener("click", () => {
  // Reset the return value
  addUserPopup.returnValue = "";
  // Show the dialog
  addUserPopup.showModal();
});

// Close button closes the dialog box
closeAddUserPopup.addEventListener("click", () => {
  addUserPopup.close();
});

// Close button closes the dialog box with a return value
// closeWithValueButton.addEventListener("click", () => {
//   addUserPopup.close(`Closed at ${new Date().toLocaleTimeString()}`);
// });

// Form close button closes the dialog box
addUserPopup.addEventListener("close", () => {
  console.log(`Dialog closed. Return value: "${addUserPopup.returnValue}"`);
});