(function () {
    var firebaseConfig = {
        apiKey: "AIzaSyAGNnVNpRPRYc7ggMTG4dESxwdn3A-luaI",
        authDomain: "luscianamanager.firebaseapp.com",
        databaseURL: "https://luscianamanager-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: "luscianamanager",
        storageBucket: "luscianamanager.firebasestorage.app",
        messagingSenderId: "375459557861",
        appId: "1:375459557861:web:4d6234200624416816ff0c",
        measurementId: "G-LQ5HYX18L8"
    };
    if (typeof firebase === 'undefined') return;
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
    window.db = firebase.database();
})();
