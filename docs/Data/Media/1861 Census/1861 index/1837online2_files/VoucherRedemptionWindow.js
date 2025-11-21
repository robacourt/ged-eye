function showRedemptionWindow() {
	var width = screen.width; 
    var height = screen.height; 
	if (width == 800)
	{
	  payment = window.open("/Trace2web/VoucherRedemptionServlet","redemption","top=0,left=0,width=800,height=600,scrollbars=yes,resizable=yes");
	  if (navigator.appName.indexOf("Microsoft") != -1)
	  {
	    payment.resizeTo(screen.availWidth,screen.availHeight);
	  }		  
	  else
	  {
	    payment.moveTo(0,0);
	    payment.outerWidth = screen.availWidth;
	    payment.outerHeight = screen.availHeight;
	  }
	}
	else
	{
	  payment = window.open("/Trace2web/VoucherRedemptionServlet","redemption","status, top=50,left=50,scrollbars=yes,resizable=yes,width=825,height=600");
	}
	payment.focus();

}