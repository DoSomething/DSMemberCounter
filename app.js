var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var stathat = require('node-stathat');
var parseString = require('xml2js').parseString;
var request = require('superagent');
var cheerio = require('cheerio');
var fs = require("fs");
var amqp = require('amqp');
var PHPUnserialize = require('php-unserialize');

var countFile = require('./count.json');
var totalUsers = countFile.total;

var app_config = require(__dirname + '/config/app_config.json');

/*
 x Integrate code from Dashboard to count members
 X Allow sockets to be opended
 X Allow GET requests
 * Scheldue PUT requests
 * StatHat
 * Find better solution to read Mobile Commons XML
 */

app.get('/', function(req, res){
 	res.send('Hi, how can I help you? Do you belong here? Whats your name? What is the answer to everything?');
});

app.get('/total', function(req, res){
	res.json({count: totalUsers});
});

io.on('connection', function(socket){
	socket.emit('count', totalUsers);
});

/*
 * Grabs the total users from the Data dashboard and returns it in a callback
 */
function calculateTotalUsers(callback){
	var url = "http://dashboards.dosomething.org/";
	var total = 0;
	request
	.get(url)
	.end(function(res) {
		var pageHTML = res.text;
		var $ = cheerio.load(pageHTML);
		var data = $('#total_member_count').text().replace("CURRENT MEMBERS: ", "");
		var num = parseInt(replaceAll(',', '', data));
		callback(num);
	});
}

/*
 * Gets the remote total and determines if we should use our local count or the
 * remote count. Also saves our current count to file.
 */
function processUsers(callback){
	calculateTotalUsers(function(remoteTotal){
		if(remoteTotal > totalUsers){
			totalUsers = remoteTotal;
		}
		countFile.total = totalUsers;
		fs.writeFile("count.json", JSON.stringify(countFile));
		callback();
	});
}

/*
 * Paginates through the last minute of mobile commons data & finds how many people
 * signed up
 */
function getMessages(pageNumber){
	var now = new Date();
	var minAgo = new Date();
	minAgo.subMinutes(1);

	request
	.get('https://secure.mcommons.com/api/messages')
	.auth(app_config.mobile_commons.user, app_config.mobile_commons.pass)
	.query({start_time: minAgo.toISOString(), include_profile: 'false', end_time: now.toISOString(), limit: '1000', page: pageNumber, include_profile: 'true'})
	.buffer()
	.accept('xml')
	.type('xml')
	.end(function(res){
	 	parseString(res.text, function (err, result) {
			var jsonResult = JSON.stringify(result);
			if(jsonResult == undefined){
				return;
			}
			var obj = JSON.parse(jsonResult);

			if(obj.response.messages[0].message == undefined){
				return
			}

			for(var index = 0; index < obj.response.messages[0].message.length; index++){
				var message = obj.response.messages[0].message[index];
				if(message == undefined){
					continue;
				}
				if(message.profile[1] == undefined){
				  	continue;
				}
				if(message['$'].type == "opt_in"){
				  increaseMemberCount();
				}
			}

			var page = parseInt(obj.response.messages[0]['$'].page);
			var totalPages = parseInt(obj.response.messages[0]['$'].page_count);
			if(page >= totalPages){
				resetTimer();
			}
			else{
				getMessages(page + 1);
			}
		});
	});

}

/*
 * Grabs the latest messages after 61 seconds.
 * Does not use interval because the timer waits for the last 'GetMessages' to
 * finish. Uses a seperate function to call getMessages in order to pass the
 * start page (1)
 */
function resetTimer(){
	setTimeout(function(){
		getMessages(1);
	}, 61 * 1000);
}

var conn = amqp.createConnection({
  host: app_config.message_broker.host,
  port: app_config.message_broker.port,
  login: app_config.message_broker.login,
  password: app_config.message_broker.password,
  connectionTimeout: app_config.message_broker.connectionTimeout,
  authMechanism: app_config.message_broker.authMechanism,
  vhost: app_config.message_broker.vhost,
  noDelay: app_config.message_broker.noDelay,
  ssl: { enabled : app_config.message_broker.ssl_enabled }
},
{
  defaultExchangeName: app_config.message_broker.defaultExchangeName
});

conn.on('ready', function(){
  console.log('rabbit connection ready');
  var q = conn.queue('activityStatsQueue', {
    passive: app_config.message_broker.passive,
    durable: app_config.message_broker.durable,
    exclusive: app_config.message_broker.exclusive,
    autoDelete: app_config.message_broker.autoDelete
  }, function (q) {
    console.log('Queue ' + q.name + ' is open');

    q.bind('#');

    q.subscribe(function (message) {
    	var serializedMessage = PHPUnserialize.unserialize(message.data.toString());
      	var activity = serializedMessage.activity;
      	switch(activity){
       		case "user_register":
          		increaseMemberCount();
          		break;
        	default:
          		break;
      	}
    });

  });
});

/*
 * Function for replacing in a string
 */
function replaceAll(find, replace, str) {
 	return str.replace(new RegExp(find, 'g'), replace);
}

function increaseMemberCount(){
	totalUsers++;
	io.emit(totalUsers);
}

Date.prototype.subMinutes = function(m) {
    this.setTime(this.getTime() - (m * 60000));
    return this;
}

function backupLoop(){
	countFile.total = totalUsers;
	fs.writeFile("count.json", JSON.stringify(countFile));
}

var server = app.listen(4012, function() {
    console.log('Listening on port %d', server.address().port);
    processUsers(function onProcess(){
    	getMessages(1);
    });
    setInterval(backupLoop, app_config.backup_time * 1000);
});