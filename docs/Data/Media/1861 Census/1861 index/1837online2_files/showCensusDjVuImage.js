

function showPhotoDjVuImage(imageName,imageStamp, desc, free, loc, u, l, s, a) {
	//Check for / patterns
	//imageName = imageName.replace(/[\/]/g, "//");
	imageName = imageName.replace(/\//g, "----");
	imageStamp = imageStamp.replace(/\//g, "----");
		
	var width = screen.width; 
    var height = screen.height; 
	if (width == 800)
	{
	
	  image = window.open("CensusShowPhotoImageServlet?imageName=" + imageName +"&imageStamp="+imageStamp+"&desc=" + desc + "&free=" + free + "&loc=" + loc + "&u=" + u + "&l=" + l + "&s=" + s + "&a=" + a,"image","top=0,left=0,width=800,height=600,scrollbars=yes,resizable=yes");
	  if (navigator.appName.indexOf("Microsoft") != -1)
	  {
	    image.resizeTo(screen.availWidth,screen.availHeight);
	  }		  
	  else
	  {
	    image.moveTo(0,0);
	    image.outerWidth = screen.availWidth;
	    image.outerHeight = screen.availHeight;
	  }
	}
	else
	{
	  image = window.open("CensusShowPhotoImageServlet?imageName=" + imageName +"&imageStamp="+imageStamp+"&desc=" + desc + "&free=" + free + "&loc=" + loc + "&u=" + u + "&l=" + l + "&s=" + s + "&a=" + a,"image","top=50, left=50, width=900,height=670,scrollbars=yes,resizable=yes");	
	  image.moveTo(10,10);
	  image.outerWidth = screen.availWidth-30;
	  image.outerHeight = screen.availHeight-30;
	  
	}
	image.focus();
}

function showDjVuImage(imageName,imageStamp, desc, free, loc, u, l, s, a) {
	//Check for / patterns
	//imageName = imageName.replace(/[\/]/g, "//");
	imageName = imageName.replace(/\//g, "----");
	imageStamp = imageStamp.replace(/\//g, "----");
	

	var width = screen.width; 
    var height = screen.height; 
	if (width == 800)
	{
	
	  image = window.open("CensusShowImageServlet?imageName=" + imageName +"&imageStamp="+imageStamp+"&desc=" + desc + "&free=" + free + "&loc=" + loc + "&u=" + u + "&l=" + l + "&s=" + s + "&a=" + a,"image","top=0,left=0,width=800,height=600,scrollbars=yes,resizable=yes");
	  if (navigator.appName.indexOf("Microsoft") != -1)
	  {
	    image.resizeTo(screen.availWidth,screen.availHeight);
	  }		  
	  else
	  {
	    image.moveTo(0,0);
	    image.outerWidth = screen.availWidth;
	    image.outerHeight = screen.availHeight;
	  }
	}
	else
	{
	  image = window.open("CensusShowImageServlet?imageName=" + imageName +"&imageStamp="+imageStamp+"&desc=" + desc + "&free=" + free + "&loc=" + loc + "&u=" + u + "&l=" + l + "&s=" + s + "&a=" + a,"image","top=50, left=50, width=900,height=670,scrollbars=yes,resizable=yes");	
	  
	  image.moveTo(10,10);
	  image.outerWidth = screen.availWidth-30;
	  image.outerHeight = screen.availHeight-30;
	}
	image.focus();
}
