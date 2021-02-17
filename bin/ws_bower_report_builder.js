var WsBowerReportBuilder = exports;
exports.constructor = function WsBowerReportBuilder(){};

var fs = require('fs');
var cli = require('cli');
var glob = require('glob');
var crypto = require('crypto');
var checksum = require('checksum');

var util  = require('util');

var MissingBower = 'Problem reading Bower.json, please check the file exists and is a valid JSON';
var invalidBowerFile = 'Problem reading Bower.json, please check that you added a NAME and VERSION to the bower.json file.';
var errorReadingBowerFiles = "error reading bower dependencies bower.json file.";


WsBowerReportBuilder.buildReport = function(){
	var depsArray = [];
	var report_JSON = {};
	var bowerFile = {};

	try{
		bowerFile = JSON.parse(fs.readFileSync('./bower.json', 'utf8'));
	}catch(e){
		cli.error(MissingBower);
		return false;
	}

	try{
		report_JSON.name = bowerFile.name;
		report_JSON.version = bowerFile.version;
	}catch(e){
		cli.error(invalidBowerFile);
		return false;
	}

	//reading bower deps report
	try{
		depsArray = JSON.parse(fs.readFileSync('./.ws_bower/.ws-sha1-report.json', 'utf8'));
	}catch(e){
		cli.error(errorReadingBowerFiles);
		return false;
	}

	return {"deps":depsArray,"report":report_JSON};
}