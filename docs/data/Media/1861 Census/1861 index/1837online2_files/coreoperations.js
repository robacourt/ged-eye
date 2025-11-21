//CoreOperations.js

// newFunction
function printerFriendlyVersion(pageReference) {
	var width = screen.width; 
    var height = screen.height; 
	if (width == 800)
	{
	  printWindow = window.open(pageReference,"print","top=0,left=0,width=800,height=600,scrollbars=yes,resizable=yes");
	  if (navigator.appName.indexOf("Microsoft") != -1)
	  {
	    printWindow.resizeTo(screen.availWidth,screen.availHeight);
	  }		  
	  else
	  {
	    printWindow.moveTo(0,0);
	    printWindow.outerWidth = screen.availWidth;
	    printWindow.outerHeight = screen.availHeight;
	  }
	}
	else
	{
	  printWindow=window.open(pageReference,"print","status=no,top=50,left=50,scrollbars=yes,resizable=yes,width=800,height=600");
	}
	printWindow.focus();
}