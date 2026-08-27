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
const editUserPopup = document.getElementById("editUserPopup");
const closeEditUserPopup = document.getElementById("closeEditUserPopup");
const promoteUserPopup = document.getElementById("promoteUserPopup");
const closePromoteUserPopup = document.getElementById("closePromoteUserPopup");
const viewUserPopup = document.getElementById("viewUserPopup");
const closeViewUserPopup = document.getElementById("closeViewUserPopup");

if (addUserPopup && openAddUserPopup && closeAddUserPopup) {
  // Add user button opens a modal dialog.
  openAddUserPopup.addEventListener("click", () => {
    addUserPopup.returnValue = "";
    addUserPopup.showModal();
  });

  // Close button closes the dialog box.
  closeAddUserPopup.addEventListener("click", () => {
    addUserPopup.close();
  });

  // Form close logs an event for debugging modal flow.
  addUserPopup.addEventListener("close", () => {
    console.log(`Dialog closed. Return value: "${addUserPopup.returnValue}"`);
  });
}

if (editUserPopup && closeEditUserPopup) {
  const editButtons = document.querySelectorAll(".editBtn");
  const editOriginalDiscordId = document.getElementById("editOriginalDiscordId");
  const editDiscordId = document.getElementById("editDiscordId");
  const editDisplayName = document.getElementById("editDisplayName");
  const editDiscordUser = document.getElementById("editDiscordUser");
  const editAccountType = document.getElementById("editAccountType");
  const editHireDate = document.getElementById("editHireDate");
  const editHouse = document.getElementById("editHouse");
  const editHousePoints = document.getElementById("editHousePoints");
  const editActivity = document.getElementById("editActivity");
  const editWeeksActivity = document.getElementById("editWeeksActivity");
  const editShift = document.getElementById("editShift");
  const editPassword = document.getElementById("editPassword");

  editButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const {
        discordId,
        displayName,
        discordUser,
        accountType,
        hireDate,
        house,
        housePoints,
        activity,
        weeksActivity,
        shift
      } = button.dataset;

      editOriginalDiscordId.value = discordId || "";
      editDiscordId.value = discordId || "";
      editDisplayName.value = displayName || "";
      editDiscordUser.value = discordUser || "";
      editAccountType.value = accountType || "Tired Esquire";
      editHireDate.value = hireDate || "";
      editHouse.value = house || "Stubo United";
      editHousePoints.value = housePoints || 0;
      editActivity.value = activity || "Active";
      editWeeksActivity.value = weeksActivity || 0;
      editShift.value = shift || "NA";
      editPassword.value = "";

      editUserPopup.returnValue = "";
      editUserPopup.showModal();
    });
  });

  closeEditUserPopup.addEventListener("click", () => {
    editUserPopup.close();
  });
}
if (viewUserPopup && closeViewUserPopup) {
  closeViewUserPopup.addEventListener("click", () => {
    viewUserPopup.close();
  });
}

if (promoteUserPopup && closePromoteUserPopup) {
  const promoteButtons = document.querySelectorAll(".promoteBtn");
  const demoteButtons = document.querySelectorAll(".demoteBtn");
  const rankActionType = document.getElementById("rankActionType");
  const promoteDiscordId = document.getElementById("promoteDiscordId");
  const promoteDisplayName = document.getElementById("promoteDisplayName");
  const currentRank = document.getElementById("currentRank");
  const promoteAccountType = document.getElementById("promoteAccountType");
  const effectiveDate = document.getElementById("effectiveDate");
  const rankOrder = [
    "Mr. Sandman",
    "Realm God",
    "Dreamy Defender",
    "Dreamland Guard",
    "Nighty Knights",
    "Tired Esquire"
  ];

  const openRankDialog = (discordId, displayName, accountType, actionType) => {
    promoteDiscordId.value = discordId || "";
    promoteDisplayName.value = displayName || "";
    currentRank.value = accountType || "";
    rankActionType.value = actionType;

    let targetRank = accountType || "Tired Esquire";
    const currentIndex = rankOrder.indexOf(accountType || "");
    if (actionType === "demote" && currentIndex >= 0 && currentIndex < rankOrder.length - 1) {
      targetRank = rankOrder[currentIndex + 1];
    }
    if (actionType === "promote" && currentIndex > 0) {
      targetRank = rankOrder[currentIndex - 1];
    }

    promoteAccountType.value = targetRank;
    effectiveDate.value = new Date().toISOString().slice(0, 10);

    promoteUserPopup.returnValue = "";
    promoteUserPopup.showModal();
  };

  promoteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const { discordId, displayName, accountType } = button.dataset;
      openRankDialog(discordId, displayName, accountType, "promote");
    });
  });

  demoteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const { discordId, displayName, accountType } = button.dataset;
      openRankDialog(discordId, displayName, accountType, "demote");
    });
  });

  closePromoteUserPopup.addEventListener("click", () => {
    promoteUserPopup.close();
  });
}