//status.js RDS 29/1/2001

var minFieldEntry=1;
var servletBase = "/";
var logout = servletBase + "DynamicPageServlet?rType=O";
var printer = servletBase + "ChargeableServlet?rType=print";
var feedback = servletBase + "StaticPageServlet?rType=feedback_menu";
var basic = servletBase + "StaticPageServlet?rType=BAS";
var address = servletBase + "StaticPageServlet?rType=ADR";
var place = servletBase + "StaticPageServlet?rType=LOC";
var institution = servletBase + "StaticPageServlet?rType=INS";
var vessel = servletBase + "StaticPageServlet?rType=VSL";
var direct = servletBase + "StaticPageServlet?rType=PIX";
var payment = servletBase + "StaticPageServlet?rType=select_payment_type";
var accounts = servletBase + "DynamicPageServlet?rType=accounts";
var image_viewer = "/image_viewer.html";
var isSSL = false;

var contentFrame = "content";
var menuFrame = "left";
var statusFrame = "bottom";
var nearSessionLimit=10;
var status = "STATUS";
var timeout = "TIMEOUT";

function isIE(){
	if(navigator.userAgent.indexOf('MSIE') !=-1) return true;
	return false;
}

function isNS6(){
	if(navigator.appName.indexOf('Netscape') >= 0 && navigator.appVersion.charAt(0) == '5') return true;
	return false;
}

function isNS4(){
	if(navigator.appName.indexOf('Netscape') >= 0 && navigator.appVersion.charAt(0) < '5') return true;
	return false;
}

function getCookie(cookieName){
	var c=document.cookie;
	if(c==null||c.length<=0) return null;
	var start=c.indexOf(cookieName+"=");
	var len = start+cookieName.length+1;
	if (start == -1){
		return null;
	}
	var end = c.indexOf(";",len);
	if (end == -1) end = document.cookie.length;
	var s=c.substring(len, end);
	return s;
}

function setCookie(name,value,path) {
    document.cookie = name + "=" +value +
        ( (path) ? ";path=" + path : "");
}

	
function deleteCookie(name,path) {
    if (getCookie(name)) document.cookie = name + "=" +
        ( (path) ? ";path=" + path : "") +
        ";expires=Thu, 01-Jan-1970 00:00:01 GMT";
}


function checkSurveyCookie(){
	var s=getCookie("SURVEY");
	deleteCookie("SURVEY", "/");
	if(s!=null&&s!=""){
		var x = 0, y = 0;
	
		if (isIE()) {
  			x = window.screenLeft + 100;
  			y = window.screenTop;// + 100;
		}
		else{
  			x = window.screenX + 100;
  			y = window.screenY + 100;
		}	
	
		var features="scrollbars=yes,resizable=yes,toolbar=no,width=700,height=400,top="+y+",screenY="+y+",left="+x+",screenX="+x;
		window.open(s,"survey",features);
	}
	return;
}


function getMenuContent(isExpanding){
      menu="";
	return menu;
}

function getStatusContent(isExpanding){
	status = "";
	return status;
}

function setSessionDetails(){
	if(!checkCookiesEnabled()){
		MM_openBrWindow('/help/Technical_help.html#cookies');
		return true;
	}
	if(!checkBrowserVersion()){
		MM_openBrWindow('/help/Technical_help.html#browser');
		return true;
	}
	
	//parent.loaded=true;
	top.loaded=true;
	return true;
}
		
function updateSessionDetails () {
	preventViewOutsideFrameset();
	checkNonSSL();
	
	if(parent != null && !parent.loaded){
		return;
	}
	window.status="Testing...";
	checkSurveyCookie();
	
	var message=getCookie("MESSAGE");
	deleteCookie("MESSAGE", "/");
	if(message!=null) alert(message);
}

function displaySearches(expand) {
		return;
}

function bg() {
        if (isIE())
        {
                document.write('<body topmargin="6" leftmargin=4 rightmargin="7" background="/images/background.gif"> ');
        }
        else
        {
                document.write('<body background="/images/background_ns.gif">');
        }
        document.close();
}

//function checkCookiesEnabled () {
//	if(getCookie(status)==null) return false;
//	return true;
//}

function checkCookiesEnabled () {
	if(getCookie("STATUS")==null) {
		setCookie("TEST", "test", "/");
		if(getCookie("TEST")==null) {
			return false;
		} else {
			deleteCookie("TEST","/");
		}
	}
	return true;
}


function checkBrowserVersion(){
	if(navigator.appVersion.charAt(0)>=4) return true;
	return false;
}

function checkNonSSL() {
	if (!isSSL && document.location.protocol=="https:") {
                var URL=escape(document.location.pathname + document.location.search);
		//alert("http://" + document.location.hostname + "/index.jsp?URL=" + URL);
		top.document.location.href="http://" + document.location.hostname + "/index.jsp?URL=" + URL;
	}
	isSSL=false;
}

function preventViewOutsideFrameset() {
	if (self == top){
		parent.top.document.location.href="index.html";
	}
}

function MM_openBrWindow(theURL) {
	var winName="help";
	var x = 0, y = 0;
	var w, h;
	
	if (isIE()) {
  		x = window.screenLeft;
  		y = window.screenTop;
		w = 600;
		h = 350;
	}
	else{
  		x = window.screenX + 100;
  		y = window.screenY + 100;
		w = 700;
		h = 400;
	}
	
	var features="scrollbars=yes,resizable=yes,toolbar=yes,width="+w+",height="+h+",top="+y+",screenY="+y+",left="+x+",screenX="+x;

        if ( parent.helpwin != null && !parent.helpwin.closed){
            parent.helpwin.location.href = theURL;
        }
        else if (parent.helpwin != null){
                        parent.helpwin = window.open(theURL,winName,features);
        }
        else{
                parent.helpwin = window.open(theURL,winName,features);
        }

        parent.helpwin.focus();

  return;
}

function validated(string, validityStr) { 
	for (var i=0; i<string.length; i++)
		 if (validityStr.indexOf(string.charAt(i)) == -1) 
			return false;
	return true;
}

function isDigit(string) {
	var allowed = '0123456789';
	if(string.length==0) return false;
	return validated(string, allowed);
}

function checkAddress(address, maxLines){
	var lines=0;
	var chars=0;
	for(var i=0;i<address.length;i++){
		if(address.charAt(i)=='\n'){
			lines++;
			chars=0;
		}
		else chars++;
		if(chars>50){
			return false;
		}
	}
	if(lines>=maxLines){
		return false;
	}
	return true;
}

function checkRows(){
	var string=document.contents.address.value;
	var i;
	var cnt=0;
	for(i=0;i<string.length;i++){
		if(string.charAt(i)=='\n') cnt++;
	}
	var rows=document.contents.address.rows;
	if(cnt>=rows) alert("You have entered too many lines for the address field. This may not print correctly.");
}

function setLoginTargetNew(name, query){
    var form = document.contents;
	form.rType.value=name;
	//alert("doing status setLoginTargetNew name:"+name+" query:" + query);
	//alert(document.location.hostname);
	if (form.SSL != null && form.SSL.checked == false) {
			form.action="https://" + document.location.hostname + "/secure_index.jsp" ;
	} else {
		form.action="secure_index.jsp";
	}

	form.submit();
}

function setLoginTarget(name, query){
    var form = document.contents;
	form.rType.value=name;
	//alert("doing status setLoginTarget");
	//alert(document.location.hostname);
	if (form.SSL != null && form.SSL.checked == false) {
		var host=document.location.hostname;
		var port = document.location.port;
		if (port != null) {
			host += ":7002";
		}
		form.action="https://" + host + query;
	} else {
		form.action=query;
	}

	form.submit();
}

function isValidField(string){
	if(string.length==0) return false;
	if(string.length<minFieldEntry) return false;
	return true;
}

function getPage(loc){
	var msg=getCookie("TEMP");
	deleteCookie("TEMP", "/");
	if(msg!=null && msg!=""){		
		setCookie("MESSAGE", msg, "/");
	}
	document.location.href = loc;
}

function MM_openSiteTour(theURL) {
	var winName="help";
	var x = 0, y = 0;
	var w, h;
	
	if (isIE()) {
  		x = window.screenLeft;
  		y = window.screenTop;
		w = 770;
		h = 500;
	}
	else{
  		x = window.screenX + 100;
  		y = window.screenY + 100;
		w = 770;
		h = 500;
	}
	
	var features="scrollbars=no,resizable=yes,toolbar=no,width="+w+",height="+h+",top="+y+",screenY="+y+",left="+x+",screenX="+x;

        if ( parent.helpwin != null && !parent.helpwin.closed){
            parent.helpwin.location.href = theURL;
        }
        else if (parent.helpwin != null){
                        parent.helpwin = window.open(theURL,winName,features);
        }
        else{
                parent.helpwin = window.open(theURL,winName,features);
        }

        parent.helpwin.focus();

  return;
}