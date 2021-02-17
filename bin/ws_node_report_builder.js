'use strict';

var traverse = require('traverse');
var cli = require('cli');
var fs = require('fs');
var glob = require("glob");
var Promise = require('bluebird');
var request = Promise.promisify(require('request'));
var execSync = require('child_process').execSync;
var constants = require('./constants');

var packageJsonText = "package.json";
var nodeModules = "node_modules";
var timeoutError = "ETIMEDOUT";
var socketTimeoutError = "ESOCKETTIMEDOUT";
var patternOfNameOfPackageFromLine = /.* (.*)@/;
var WsNodeReportBuilder = exports;
exports.constructor = function WsNodeReportBuilder() { };

WsNodeReportBuilder.refitNodes = function (obj) {
    var build, key, destKey, ix, value;
    var mapShortToLong = {
        "dependencies": "children",
        "resolved": "artifactId"
    };

    build = {};
    for (key in obj) {

        // Get the destination key
        destKey = mapShortToLong[key] || key;

        // Get the value
        value = obj[key];

        // If this is an object, recurse
        if (typeof value === "object") {
            value = WsNodeReportBuilder.refitNodes(value);
        }

        // Set it on the result using the destination key
        build[destKey] = value;
        if (destKey === "children") {
            build[destKey] = [];
            for (var i in value) {
                build[destKey].push(value[i]);
                value[i].name = i;
                value[i].groupId = i;
                value[i].systemPath = null;
                value[i].scope = null;;
                value[i].exclusions = [];
                value[i].classifier = null;
            }
        }
    }
    return build;
};


function replaceScopedDependencies(objPointer) {
    var baseIndex = 0;
    var count = (objPointer.match(/@/g) || []).length;
    for (var i = 0; i < count; i++) {
        var atIndex = objPointer.indexOf("@", baseIndex);
        var bracketsIndex = objPointer.indexOf("][", atIndex);
        objPointer = objPointer.substring(0, bracketsIndex - 1) + "/" + objPointer.substring(bracketsIndex + 3);
        baseIndex = bracketsIndex;
    }
    return objPointer;
}

function getPackageJsonPath(uri, excludes) {
    var originalUri = uri;
    while ((excludes.indexOf(uri) != -1 || !fs.existsSync(uri)) && uri != packageJsonText) {
        var count = (uri.match(/\//g) || []).length;
        if (count > 3) {
            var nodeIndex = uri.lastIndexOf("/node_modules/");
            if (nodeIndex > -1) {
                var endingPath = uri.substring(nodeIndex + 13);
                var tempPath = uri.substring(0, nodeIndex);
                var lastSlash = tempPath.lastIndexOf("/");
                var basePath = tempPath.substring(0, lastSlash);
                var possibleAtIndex = basePath.lastIndexOf("/");
                if (basePath.charAt(possibleAtIndex + 1) == "@") {
                    basePath = basePath.substring(0, possibleAtIndex);
                }
                uri = basePath + endingPath;
            }
        } else {
            uri = originalUri;
            while ((excludes.indexOf(uri) != -1 || !fs.existsSync(uri)) && uri != packageJsonText) {
                uri = uri.substring(uri.indexOf("/") + 1);
                if (uri.startsWith("@")) {
                    uri = uri.substring(uri.indexOf("/") + 1);
                }
                uri = uri.substring(uri.indexOf("/") + 1);
            }
        }
    }
    if (uri === packageJsonText) {
        uri = originalUri;
        var midPackages = uri.split(/node_modules/g);
        for (var i = 1; i < midPackages.length - 1; i++) {
            uri = nodeModules + midPackages[i] + nodeModules + midPackages[midPackages.length - 1];
            if (uri != packageJsonText && fs.existsSync(uri) && excludes.indexOf(uri) == -1) {
                return uri;
            }
        }
        uri = packageJsonText;
    }

    return uri;
}

function removeDuplicatesWithNpmLs(dependenciesWithDuplicates, npmLs, index, dependenciesWithoutDuplicates, foundedAndMissing) {
    if (dependenciesWithDuplicates != null && dependenciesWithDuplicates.hasOwnProperty(constants.CHILDREN)) {
        var childrenJsonObject = dependenciesWithDuplicates.children;
        for (var i = 0; i < childrenJsonObject.length; i++) {
            var currentLine = npmLs[index];
            if (currentLine.endsWith(constants.DEDUPED)) {
                index++;
                continue;
            }
            var dependencyAlias = getTheNextPackageNameFromNpmLs(currentLine);
            if (dependencyAlias != null) {
                var dependencyJsonObject = getDependency(childrenJsonObject, dependencyAlias);
                if (dependencyJsonObject == null) {
                    index++;
                    i--;
                    continue;
                }
                if ((dependencyJsonObject != null && dependencyJsonObject.sha1 != null && dependencyJsonObject.sha1 !== constants.EMPTY_STRING) || (dependencyJsonObject != null && dependencyJsonObject.shasum != null && dependencyJsonObject.shasum !== constants.EMPTY_STRING)) {
                    foundedAndMissing.foundedShasum++;
                } else {
                    foundedAndMissing.missingShasum++;
                }
                var dependency = dependencyJsonObject;
                dependenciesWithoutDuplicates.push(dependency);
                var childDependencies = [];
                index = removeDuplicatesWithNpmLs(dependencyJsonObject, npmLs, index + 1, childDependencies, foundedAndMissing);
                dependency.children = childDependencies;
            } else {
                index++;
            }
        }
    }
    return index;
}

function getDependency(children, name) {
    for (var key in children) {
        if (children[key].name === name) {
            return children[key];
        }
    }
}

function getTheNextPackageNameFromNpmLs(currentLine) {
    var match = currentLine.match(patternOfNameOfPackageFromLine);
    if (match) {
        return match[1];
    }
}

WsNodeReportBuilder.traverseLsJson = function (npmLsJson, npmLs, registryAccessToken) {
    cli.ok("Building dependencies report");
    var invalidDeps = [];
    var parseData = npmLsJson;
    var scrubbed = traverse(parseData).paths();
    var cmd = "npm get registry";
    var registryUrl;
    try {
        registryUrl = execSync(cmd);
    } catch (e) {
        // do nothing
    }
    registryUrl = registryUrl.toString().substring(0, registryUrl.length - 1);

    // Create "endsWith" function for node version 0.10.x and earlier.
    String.prototype.endsWith = String.prototype.endsWith || function (str) {
        return new RegExp(str + "$").test(str);
    };

    var getParentDepPointer = function (depPointer) {
        //Example :  "[dependencies"]["ft-next-express"]["dependencies"]["@financial-times"]["n-handlebars"]"

        //["n-handlebars"]"
        var childDepStr = depPointer.substr(depPointer.lastIndexOf('['), depPointer.lastIndexOf(']'));

        //"n-handlebars"
        var childDepName = JSON.parse(childDepStr)[0];

        //"[dependencies"]["ft-next-express"]["dependencies"]["@financial-times"]"
        var ansStr = depPointer.substr(0, depPointer.lastIndexOf('['));

        //"[dependencies"]["ft-next-express"]["dependencies"]["@financial-times"
        var transStr = ansStr.substring(0, ansStr.lastIndexOf('"]'));

        //"[dependencies"]["ft-next-express"]["dependencies"]["@financial-times" + / + child + "]";
        var fixedStr = transStr + "/" + childDepName + '"]';
        return fixedStr;

    };

    var requestPromises = [];
    var sha1sMap = {};

    for (var i = 0; i < scrubbed.length; i++) {
        var path = scrubbed[i];

        // There is a section called "problems", it includes the missing packages list
        // We want to ignore this section
        if(path.indexOf("problems") > -1 ) {
			continue;
		}
        var isRequired = false;

        for (var j = 0; j < path.length; j++) {
            var isDep = (path[j] === "dependencies");
            var isVer = (path[j] === "version");
            var isResolved = (path[j] === "resolved");
            var isFrom = (path[j] === "from");
            var isName = (path[j] === "name");
            var isShasum = ((path[j] === "shasum") || (path[j] === "_shasum")); //shasum can be "_shasum"
            //	var isShasum = (path[j] === "shasum"); //shasum can be "_shasum"
            var isMissing = (path[j] === "missing" || path[j] === "peerMissing");
            isRequired = (path[j] === "required") || isRequired;
            var isNodeMod = (path[j] === "node_modules");
            if (isDep) {
                path[j] = "node_modules";
                isNodeMod = true;
            }

            var SLASH = "/";
            var fullUri = scrubbed[i].join(SLASH) + SLASH + packageJsonText;
            var isValidPath = true;
            if ((fullUri.endsWith("/dev/" + packageJsonText) && !fullUri.endsWith("node_modules/dev/" + packageJsonText)) ||
                (fullUri.endsWith("/optional/" + packageJsonText) && !fullUri.endsWith("node_modules/optional/" + packageJsonText))) {
                isValidPath = false;
            }

            if (path[j] === path[path.length - 1] && j === (path.length - 1)
                && !isName && !isNodeMod && !isFrom
                && !isResolved && !isVer && !isShasum && isValidPath && !isMissing && !isRequired) {

                //console.log('scanning for shasum at path: ' + fullUri )
                var strArr = fullUri.split("");
                for (var k = 0; k < strArr.length; k++) {
                    if (strArr[k] == SLASH) {
                        strArr[k] = '"]["';
                    }
                }

                var dataObjPointer;
                var joinedStr = strArr.join('');
                joinedStr = joinedStr.substr(0, joinedStr.lastIndexOf('['));
                var objPointer = 'parseData["' + joinedStr.replace(/node_modules/gi, "dependencies");
                objPointer = replaceScopedDependencies(objPointer);

                var invalidProj = false;
                try {
                    dataObjPointer = eval(objPointer);
                } catch (e) {
                    invalidProj = true;
                }
                try {
                    var uri = fullUri;
                    var badPackage = false;
                    var excludes = [];
                    uri = getPackageJsonPath(uri, excludes);
                    if (uri === packageJsonText || !uri.endsWith(packageJsonText)) {
                        invalidProj = true;
                        // badPackage = true;

                    }

                    var packageJson = JSON.parse(fs.readFileSync(uri, 'utf8'));
                    while (!invalidProj && packageJson != null && packageJson.version != dataObjPointer.version) {
                        excludes.push(uri);
                        uri = getPackageJsonPath(fullUri, excludes);
                        if (uri === packageJsonText || !uri.endsWith(packageJsonText)) {
                            invalidProj = true;
                            break;
                        }
                        packageJson = JSON.parse(fs.readFileSync(uri, 'utf8'));
                    }
                    if (invalidProj && !badPackage) {
                        dataObjPointer = parseData.dependencies[packageJson.name];
                        if (packageJson._from && packageJson._resolved && packageJson.version) {
                            if (!dataObjPointer) {
                                dataObjPointer = {};
                            }
                            dataObjPointer.from = packageJson._from;
                            dataObjPointer.resolved = packageJson._resolved;
                            // dataObjPointer.version = obj.version;
                            invalidProj = false;
                        } else {
                            var pointerString = objPointer.substring('parseData'.length);
                            if (!eval(objPointer)) {
                                var parentDepPointer = getParentDepPointer(pointerString);
                                invalidDeps.push(parentDepPointer);
                                objPointer = 'parseData' + parentDepPointer;
                            }
                            var parentDep = eval('delete ' + objPointer);
                            packageJson.name = path[path.length - 1];
                        }
                    }
                } catch (e) {
                    console.log(e);
                }

                if (packageJson._resolved) {
                    var resolved = packageJson._resolved;
                    if (resolved.indexOf("git+") > -1 || resolved.indexOf("github:") > -1){
                        cli.info(packageJson.name + ":  This configuration (remote repository packages) is not supported by WhiteSource. Please use direct URL package references.");
                        continue;
                    }
                }

                if ((!invalidProj) && (packageJson.dist || packageJson._shasum) && dataObjPointer) {
                    if (packageJson._resolved) {
                        dataObjPointer.resolved = packageJson._resolved.substring(resolved.lastIndexOf(SLASH) + 1);
                    }
                    if (packageJson.dist) {
                        dataObjPointer.shasum = packageJson.dist.shasum;
                        path.shasum = packageJson.dist.shasum;
                    }
                    if (packageJson._shasum) {
                        dataObjPointer.sha1 = packageJson._shasum;
                        dataObjPointer.shasum = packageJson._shasum;
                        path.shasum = packageJson._shasum;
                        path.sha1 = packageJson._shasum;
                    }
                    sha1sMap[path.shasum] = true;
                } else if (!invalidProj && dataObjPointer && packageJson._resolved) {
                    // Query the npm registry for ths package sha1
                    var registryPackageUrl;
                    if (registryUrl != null && resolved.indexOf(registryUrl) > -1) {
                        registryPackageUrl = registryUrl + packageJson.name;
                    } else {
                        var urlName = "/" + packageJson.name;
                        var regexRegistry = new RegExp("(.*)\/[^A-Za-z0-9\/].*");
                        var resultOfMatch = resolved.match(regexRegistry);
                        if (resultOfMatch != null) {
                            registryPackageUrl = resultOfMatch[1];
                        }
                        var regexToFindIfPackageNameInclude = new RegExp(".*\/" + packageJson.name + "$");
                        if (registryPackageUrl.match(regexToFindIfPackageNameInclude) == null) {
                            registryPackageUrl = registryPackageUrl + urlName;
                        }
                    }
                    let url = registryPackageUrl + "/" + packageJson.version;
                    var privateRegistry = false;
                    if(url.indexOf(constants.NPM_REGISTRY) === -1) {
                        privateRegistry = true;
                        url = registryPackageUrl + '?' + packageJson.version;
                    } else {
                        if (url.startsWith(constants.HTTPS)) {
                            let urlWithoutHttps = url.substring(constants.HTTPS.length);
                            url = constants.HTTP + urlWithoutHttps;
                        }
                        if (url.indexOf('@') > -1) {
                            var slashIndex = registryPackageUrl.lastIndexOf("/");
                            url = registryPackageUrl.substring(0,slashIndex) + "%2F" + registryPackageUrl.substring(slashIndex + 1) + '?' + packageJson.version;
                        }
                    }
                    let promisePackageJson = packageJson;
                    let promisePath = path;
                    let promiseDataObjPointer = dataObjPointer;
                    var options = {timeout: 30000};
                    if(registryAccessToken !== null && registryAccessToken.length > 0) {
                        options.headers = {
                            Authorization: 'Bearer ' + registryAccessToken,
                            'Content-Type': 'application/json'
                        }
                    }

                    let promise = request(url, options)
                        .then(function (response) {
                            var postUrl = response.request.href;
                            if (response.statusCode !== 200) {
                                console.error("Cannot obtain sha1 from " + postUrl + ": " + response.statusMessage);
                                cli.info('Missing : ' + promisePackageJson.name);
                            } else {
                                const body = response.body;
                                var registryResponse = JSON.parse(body);
                                if (postUrl.indexOf("%2F") > -1 || postUrl.indexOf(constants.NPM_REGISTRY) === -1) {
                                    var version = postUrl.substring(postUrl.lastIndexOf('?') + 1);
                                    registryResponse = registryResponse.versions[version];
                                }

                                if (registryResponse.dist && registryResponse.dist.shasum) {
                                    if (promisePackageJson._resolved) {
                                        promiseDataObjPointer.resolved = promisePackageJson._resolved.substring(promisePackageJson._resolved.lastIndexOf(SLASH) + 1);
                                    }
                                    const shasum = registryResponse.dist.shasum;
                                    promiseDataObjPointer.sha1 = shasum;
                                    promiseDataObjPointer.shasum = shasum;
                                    promisePath.shasum = shasum;
                                    promisePath.sha1 = shasum;
                                    // console.log("Got a response: ", shasum);
                                } else {
                                    console.error("Response from " + postUrl + " does not contain the object 'shasum' under 'dist'");
                                    cli.info('Missing : ' + promisePackageJson.name);
                                }
                            }
                        })
                        .catch(function (error) {
                            // var missingPackage = "" + obj.name + " is missing";
                            if (error.code === timeoutError || error.code === socketTimeoutError) {
                                console.error("Timeout when reaching to package in url:  " + url);
                            } else {
                                console.error("Error when reaching to package in url: " + url + ": " + error.message);
                            }
                        });

                    requestPromises.push(promise);

                } else {//couldn't find shasum key
                    cli.info('Missing : ' + packageJson.name);
                }
            }
        }
    }

    return Promise.all(requestPromises)
        .then(function () {
            return finalizeDependencies(parseData, npmLs);
        });
};

WsNodeReportBuilder.traverseYarnData = function(yarnDependencies){
    cli.ok("Building yarn dependencies report");
    // parsing the yarn.lock file, which lists all the project's dependencies, using only 2 levels.
    // each child dependency appears twice - once as a child and once as a parent;
    // each parent dependency (at the project's root) appears only once
    var parentsMap = {}; // a map of parent dependencies:  the key is the name and and value is the object
    var childrenMap = {}; // a map of children dependencies:  the key is the name and version; the value is the parent's object
    var sha1Map = {}; // a map of all dependencies: the key is sha1 and the value is the object
    var foundedShasum = 0;
    var missingShasum = 0;
    for (let depName in yarnDependencies) {
        // checking that the package exists in the list and getting its details
        if (!Object.hasOwnProperty.call(yarnDependencies, depName)) {
            continue;
        }

        let packageName = depName;
        const details = yarnDependencies[depName];
        if (!details.resolved) {
            cli.info('Missing install url: ' + depName);
            continue;
        }

        const packageSeparatorIndex = depName.lastIndexOf('@');
        if (packageSeparatorIndex > 0) {
            packageName = depName.substr(0, packageSeparatorIndex);
        }

        // retrieving sha1 and URL
        let shasumUrl = getShasumUrl(details);
        let shasum = shasumUrl["shasum"];
        let url = shasumUrl["url"];

        let packageInfo = {};
        if (sha1Map[shasum]) { // if dependency was already found - use existing object
            packageInfo = sha1Map[shasum];
        } else {
            packageInfo = {
                groupId: packageName,
                artifactId: url,
                name: packageName,
                shasum, sha1: shasum,
                version: details.version,
                from: packageName + "@" + details.version
            };
            sha1Map[shasum] = packageInfo;
            if (shasum == null || shasum == constants.EMPTY_STRING){
                missingShasum++;
            } else {
                foundedShasum++;
            }
        }

        // list child dependencies
        getChildDependencies(details, "dependencies", packageInfo);
        getChildDependencies(details,"optionalDependencies", packageInfo);
        packageInfo["children"] = [];

        // add to parent' map (if not there already)
        if (!parentsMap[depName]) {
            parentsMap[depName] = packageInfo
        }
    }

    // for each child dependency - add it to its parent dependency
    for (let child in childrenMap){
        childrenMap[child].children.push(parentsMap[child])
    }

    let allChildren = [];
    // for each dependency in the parents' map - if its not a child of other dependency - add it to the final list
    for (let dependency in parentsMap){
        if (!childrenMap[dependency] && allChildren.indexOf(parentsMap[dependency]) == -1 ){
            allChildren.push(parentsMap[dependency]);
        }
    }

    function getShasumUrl(details) {
        let shasum = null;
        let hashIndex = details.resolved.indexOf('#');
        let url = details.resolved;
        if (hashIndex > 0) {
            shasum = details.resolved.substr(hashIndex + 1);
            url = details.resolved.substr(0, hashIndex);
        } else {
            const urlParts = /\/tar.gz\/([0-9a-f]+)$/.exec(details.resolved);
            if (urlParts) {
                shasum = urlParts[1];
                url = url.substr(0, url.length - urlParts[1].length - 1);
            }
        }
        let output = {}
        output["shasum"] = shasum;
        output["url"] = url;
        return output;
    }

    function getChildDependencies(details, type, packageInfo) {
        let children = [];
        if (Object.hasOwnProperty.call(details, type)) {
            let depDependencies = details[type];
            for (let child in depDependencies){
                let childName = child + "@" + depDependencies[child];
                if (!childrenMap[childName]) {
                    childrenMap[childName] = packageInfo;
                }
            }
        }
        return children;
    }

    printFoundShasumData(foundedShasum, missingShasum);
    return allChildren;
}


function finalizeDependencies(parseData, npmLs){
    removeMissingDependencies(parseData);
    let dependenciesWithDuplicates = WsNodeReportBuilder.refitNodes(parseData);
    var dependenciesWithoutDuplicates = { name: dependenciesWithDuplicates.name, version: dependenciesWithDuplicates.version, children: [] };
    var foundedAndMissing = {
        foundedShasum: 0,
        missingShasum: 0
    };
    var linesOfNpmLs = npmLs.split('\n');
    removeDuplicatesWithNpmLs(dependenciesWithDuplicates, linesOfNpmLs, 1, dependenciesWithoutDuplicates.children, foundedAndMissing);
    printFoundShasumData(foundedAndMissing.foundedShasum, foundedAndMissing.missingShasum);
    return dependenciesWithoutDuplicates;
}

function removeMissingDependencies(parseData) {
    var dependencies = parseData.dependencies;
    for (var dependency in dependencies){
        if (dependencies[dependency].version == undefined){
            delete dependencies[dependency];
        }
    }
}

function printFoundShasumData (found, missed){
    cli.info("Total shasum found: " + found);
    cli.info("Missing shasum: " + missed);
    cli.info("Total project dependencies: " + (found + missed));
}

