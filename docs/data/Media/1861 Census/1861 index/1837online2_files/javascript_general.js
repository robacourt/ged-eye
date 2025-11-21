  today=new Date();
  jran=today.getTime();

  function rnd() {
    ia=9301;
    ic=49297;
    im=233280;
    jran = (jran*ia+ic) % im;
    return jran/(im*1.0);
  }
  
  function rand(number) {
    return Math.ceil(rnd()*number);
  }
  
  function changeImage() {
    var dimg = document.images;
    maxNum = 1;                        // the total number of images the script can pick from:
    myNum=(rand(maxNum));              // ie; image1.jpg; image2.jpg; image3.jpg; image4.jpg
  
    // Ensure this name .randomimage. is the same as the name given to the image above.
  
    dimg.randomimage.src = ("images/random/image" + myNum + ".jpg");
  }

  function addfavourite() {
   var myurl, mytitle;
   myurl = "http://www.1837online.com";
   mytitle = "1837online.com - the key to family history";
   if (document.all) {
     window.external.AddFavorite(myurl, mytitle);
   }
  }
  
  function close_window() {
    window.close();
  }

  function ExplorerFix() {
    for (a in document.links) document.links[a].onfocus = document.links[a].blur;
  }
  
  function MM_findObj(n, d) { //v4.0
    var p,i,x;  if(!d) d=document; if((p=n.indexOf("?"))>0&&parent.frames.length) {
      d=parent.frames[n.substring(p+1)].document; n=n.substring(0,p);}
    if(!(x=d[n])&&d.all) x=d.all[n]; for (i=0;!x&&i<d.forms.length;i++) x=d.forms[i][n];
    for(i=0;!x&&d.layers&&i<d.layers.length;i++) x=MM_findObj(n,d.layers[i].document);
    if(!x && document.getElementById) x=document.getElementById(n); return x;
  }
  
  function MM_jumpMenu(targ,selObj,restore){ //v3.0
    eval(targ+".location='"+selObj.options[selObj.selectedIndex].value+"'");
    if (restore) selObj.selectedIndex=0;
  }

  function MM_openBrWindow(theURL,winName,features) { //v2.0
    window.open(theURL,winName,features);
  }
  
  function MM_preloadImages() { //v3.0
    var d=document; if(d.images){ if(!d.MM_p) d.MM_p=new Array();
      var i,j=d.MM_p.length,a=MM_preloadImages.arguments; for(i=0; i<a.length; i++)
      if (a[i].indexOf("#")!=0){ d.MM_p[j]=new Image; d.MM_p[j++].src=a[i];}}
  }
  
  function MM_swapImage() { //v3.0
    var i,j=0,x,a=MM_swapImage.arguments; document.MM_sr=new Array; for(i=0;i<(a.length-2);i+=3)
     if ((x=MM_findObj(a[i]))!=null){document.MM_sr[j++]=x; if(!x.oSrc) x.oSrc=x.src; x.src=a[i+2];}
  }

  function MM_swapImgRestore() { //v3.0
    var i,x,a=document.MM_sr; for(i=0;a&&i<a.length&&(x=a[i])&&x.oSrc;i++) x.src=x.oSrc;
  }
  
  function magnifyImage(intelement, strImage, intX, intY) {
    if (intX < 110) {intX = 110;}
    window.open ("/eSolutions-Engine/magnifyimage.asp?product="+intelement+"&image=" + strImage, "NewWin", "resizable=1,width=" + (intX + 18) + ",height=" + (intY + 45));
  }    

  function openGallery(intelement, strType) {
    window.open ("/eSolutions-Engine/gallery.asp?intelement="+intelement+"&strType="+strType, "Gallery", "resizable=1,width=400,height=280");
  }       

  function showImage(strImage, intX, intY) {
    if (intX < 110) {intX = 110;}
    window.open ("../includes/viewimage.asp?image=" + strImage, "NewWin", "resizable=1,width=" + (intX + 18) + ",height=" + (intY + 40));
  }
  
  function SwapButtonImage(intIndex) {
    if (intIndex != (intCurIndex + 1)) {
      MM_swapImage('blank0' + intIndex,'','images/bttnBlankRo.gif',1);
    }
  }

  function SwapButtonImageRestore(intIndex) {
    if (intIndex != (intCurIndex + 1)) {
      MM_swapImgRestore();
    }
  }

  function validateLogin(){
    var strerror = "";
    var formname = document.signin;
    var emailReg1 = /(@.*@)|(\.\.)|(@\.)|(\.@)|(^\.)/; // not valid
    var emailReg2 = /^.+\@(\[?)[a-zA-Z0-9\-\.]+\.([a-zA-Z]{2,}|[0-9]{1,3})(\]?)$/; // valid

    if (formname.email.value.length < 1) {strerror = strerror + "Email\n";}
    if (formname.password.value.length < 1) {strerror = strerror + "Password\n";}

//    if (formname.email.value.length > 0){
//      if (!emailReg1.test(formname.email.value) && emailReg2.test(formname.email.value)){
//      }else{
//        strerror = strerror + "Email\n";
//      }
//    }

    if (strerror != "") {
      alert("Please enter the following fields:\n\n" + strerror);
	  return false;
    }
    else {
      document.signin.submit();
    }
  }

