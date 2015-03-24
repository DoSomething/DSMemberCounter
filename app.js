var config = require(__dirname + '/config/app_config.json');

var express = require('express');
var app = express();
var http = require('http').Server(app);
var stathat = require('node-stathat');
var request = require('superagent');

var mysql = require('mysql');
var connection = mysql.createConnection({
  host: config.SQL_HOST,
  user: config.SQL_USER,
  password: config.SQL_PASSWORD
});

app.get('/', function(req, res){
 	res.send('This counts things.');
});

function getMemberCount(callback) {
  connection.query("select total from overall.total", function(err, rows, fields) {
    if(err) {
      console.log(err);
    }
    callback(rows[0]);
  });
}

function updateApplications() {
  getMemberCount(function(data) {
    updateDrupal(data);
    //TODO: Update lobby dash
  });
}

function updateDrupal(data) {
  request
   .post(config.DRUPAL_AUTH)
   .set('Content-Type', 'application/json')
   .set('Accept', 'application/json')
   .send({"username": config.DRUPAL_USERNAME, "password": config.DRUPAL_PASSWORD})
   .end(function(res){
      var raw = res.body;
      var drupalToken = raw.token;
      var drupalSessid = raw.sessid;
      var drupalSessionName = raw.session_name;
      request
       .post(config.SET_VAR)
       .set('Accept', 'application/json')
       .set("Content-type", "application/json")
       .set("X-CSRF-Token", drupalToken)
       .set("Cookie", drupalSessionName + "=" + drupalSessid)
       .send({"name": "dosomething_user_member_count", "value": data.total})
       .end(function(res){
         console.log("Updated Drupal, Status Code: " + res.status);
      });
  });
}

var server = app.listen(4123, function() {
    console.log('Listening on port %d', server.address().port);
    updateApplications();
    setTimeout(updateApplications, (5 * 60) * 1000); //Updates every 5 minutes
});
