//search.js RDS 29/1/2001

var minNumSearchChars=3;
var charsBeforeWildcard=2;
var addressSearch="ADR";
var addressSearchWithLocale="ADL";
var localeSearch="LOC";
var directSearch="PIX";
var basicSearch="BAS";
var expandedSearch="PSR";
var expandedLocaleSearch="PSL";
var institutionSearch="INS";
var vesselSearch="VSL";
var charge="/images/charge_yes.gif";
var nocharge="/images/charge_no.gif";
var blank="/images/charge_blank.gif";

function isValidSearchString(string){
	var i;
	var cnt=0;
	var len=string.length;
	if(string.charAt(0)==' ') return false;
	for(i=0;i<len;i++){
		if(string.charAt(i)=='%'||string.charAt(i)=='*'||string.charAt(i)=='_'||string.charAt(i)=='\t'||string.charAt(i)=='?') cnt++;
	}
	if(cnt==len) return false;
	minNumSearchChars=document.contents.minNumSearchChars.value;
	if(string.length>=minNumSearchChars) return true;
	return false;
}
function isValidStreet(string){
	var i=0;
	var cnt=0;
	var len=string.length;
	// skip numbers and spaces
	while ( i < len && (isDigit(string.charAt(i)) ||
		string.charAt(i)==' '||string.charAt(i)=='\t')) {
		i++;
	}
	while  ( i < len && string.charAt(i)!='%'&&string.charAt(i)!='*'&&string.charAt(i)!='_'&&string.charAt(i)!='?') {
		if  ( string.charAt(i)==' '||string.charAt(i)=='\t') {
		}
		else {
			cnt++;
		}
		i++;
	}
	minNumSearchChars=document.contents.minNumSearchChars.value;
	if(cnt>=minNumSearchChars) return 0;
	if (i < len) return 1;
	return 2;
}
function isValidWildcard(string){
	charsBeforeWildcard=document.contents.charsBeforeWildcard.value;
	for(var i=0;i<string.length;i++){
		if(string.charAt(i)=='%'||string.charAt(i)=='*'||string.charAt(i)=='_'){
			if(i<charsBeforeWildcard) return false;
		}
	}
	return true;
}

function isValidMultipleWordWildcard(multipleWordString)
{
  var numberOfCharacters = multipleWordString.length;
  var charCount = 0;
  var validString = true;

  for(var count = 0; count < numberOfCharacters; count++)
  {
    if(multipleWordString.charAt(count) == ' ')
    {
      charCount = 0;
    }
    else if(multipleWordString.charAt(count) == '%' ||
       multipleWordString.charAt(count) == '_' ||
       multipleWordString.charAt(count) == '*')
    {
      if(charCount < 2)
      {
        validString = false;
        count = numberOfCharacters;
      }
    }
    else
    {
      charCount++;
    }
  }
  
  return validString;
}

function removeAllSpaces(){
	var fieldArray=document.contents.elements;
	var total = fieldArray.length;
	var cnt;
	var field;
	for(cnt=0;cnt<total;cnt++){
		field=fieldArray[cnt];
		if(typeof field.value == 'string'){
			if(isAllSpaces(field.value)){
				field.value="";
			}
		}
	}
}

function isAllSpaces(field){
	if(field.length>0){
		var allSpaces=true;
		var cnt;
		for(cnt=0;cnt<field.length;cnt++){
			if(field.charAt(cnt)!=' ' && field.charAt(cnt)!='\t') allSpaces=false;
		}
		return allSpaces;
	}
	return false;
}

function validateSearch () {
	if (validateSearchCheck()) {
		document.contents.submit();
	}
}
/***************/
function validateSearchCheck () {
	var notEntered="The following must be entered:";
	var nameMissing="You must enter either Last Name or First Name";
	var ageMissing="If you enter only First Name, you must also enter Gender, Age and Where Born";
	var not="NOT cannot be used as a place keyword.";
	var NAN=" must be a number";
	var msg="";
	var newEntry=true;
	var wildcard="At least "+charsBeforeWildcard+" characters must be entered before a wildcard";
	
	removeAllSpaces();

	var correct=true;

    if(document.contents.rType.value==addressSearch)
    {
		var street=document.contents.street;
		var localeKeywords=document.contents.localeKeywords;
		
        var streetPresent = false;
        var localePresent = false;        

        if(street.value.length == 0) 
        {
		  streetPresent = false;
        }
        else
        {
          streetPresent = true;
        }

        if(localeKeywords.value.length == 0)
        {
          localePresent = false;
        }
        else
        {
          localePresent = true;
        }

        if(!streetPresent)
        {
          correct = false;
          if(newEntry)
          {
            msg += notEntered;
            newEntry = false;
          }

          msg += "\nHouse and/or Street";
          street.focus();
        }
        
        if(!localePresent)
        {
          correct = false;
          if(newEntry)
          {
            msg += notEntered;
            newEntry = false;
          }

          msg += "\nPlace Keywords";
          localeKeywords.focus();

        }
        
        if(correct == true)
        {
		  prob = isValidStreet(street.value);
		  if( prob > 0)
		  {
			correct=false;
			if ( prob == 1)
			{
				msg+="\n"+wildcard + ", not including house numbers";
			}
			else
			{
				msg+="The House and/or Street field must contain a house or street name.";
			}
		
			street.focus();
		  }

          var validStreet = isValidMultipleWordWildcard(street.value);
          if(validStreet == false)
          {
            if(!correct)
			{
				msg += "\n\n";
			}
            else
            {
       			msg += "Need to have at least two characters before each wildcard";
            }
		               
			correct = false;
 			street.focus();
          }
 		
          if(localeKeywords.value.toUpperCase().indexOf('NOT ') == 0)
		  {
		  	if(!correct)
			{
				msg += "\n\n";
			}
		
			correct = false;
			msg += not;
			localeKeywords.focus();
		  }
		
          if(!isValidSearchString(localeKeywords.value))
          {
            if(!correct)
            {
              msg += "\n\n";
            } 

            msg += "Place Keywords is an invalid search parameter.\n";
            correct = false;
          }

		  if(!isValidWildcard(localeKeywords.value))
		  {
			if(!correct)
			{
				msg += "\n\n";
			}
		
			correct=false;
			msg+=wildcard;
		  }

          var vaildPlaceKeywords = isValidMultipleWordWildcard(localeKeywords.value);
          if(vaildPlaceKeywords == false)
          {
            if(!correct)
			{
			  msg += "\n\n";
			}
            else
            {
              if(validStreet == true)
              {
	    		  msg += "Need to have at least two characters before each wildcard\n";
              }
            }

            correct = false;
 			localeKeywords.focus();
          }
        }
    }
	else if(document.contents.rType.value==addressSearchWithLocale)
	{
		var street=document.contents.street;
    	var adminCounty=document.contents.adminCounty;
		var civilParish=document.contents.civilParish;
		var municipalBorough=document.contents.municipalBorough;
		var municipalWard=document.contents.municipalWard;
		var urbanSanitaryDistrict=document.contents.urbanSanitaryDistrict;
		var town=document.contents.town;
		var ruralSanitaryDistrict=document.contents.ruralSanitaryDistrict;
		var borough=document.contents.borough;
		var ecclParish=document.contents.ecclParish;
		var wildCardProb=false;
		
        var streetPresent = false;
        var otherPresent = false;

        if(street.value.length == 0) 
        {
		  streetPresent = false;
        }
        else
        {
          streetPresent = true;
        }

        if ((adminCounty.value.length == 0)           && 
            (civilParish.value.length == 0)           && 
            (municipalBorough.value.length == 0)      && 
            (municipalWard.value.length == 0)         &&
            (town.value.length == 0)                  && 
            (ruralSanitaryDistrict.value.length == 0) && 
            (borough.value.length == 0)               && 
            (ecclParish.value.length == 0))
        {
          otherPresent = false;
        }
        else
        {
          otherPresent = true;
        }

        if(!streetPresent || !otherPresent)
        {
          correct=false;
		  if(newEntry)
		  {
		    msg+=notEntered;
		    newEntry=false;
		  }
			
		  msg+="\nHouse/Street and at least one other field";
		  street.focus();
        }

        if(correct == true)
        {
		  prob = isValidStreet(street.value);
		  if( prob > 0)
		  {
			correct=false;
			if (prob == 1)
			{
				msg+="\n"+ wildcard + ", not including house numbers";
			}
			else
			{
				msg+="The House and/or Street field must contain a house or street name.";
  			}
		
			street.focus();
		  }

          var validStreet = isValidMultipleWordWildcard(street.value);
          if(validStreet == false)
          {
            if(!correct)
		    {
		      msg += "\n\n";
		    }
		    else
            {
              msg += "Need to have at least two characters before each wildcard";
            }
		    
            correct = false;
		    street.focus();
          }

          if(  !isValidSearchString(adminCounty.value)
            && !isValidSearchString(civilParish.value)
            && !isValidSearchString(municipalBorough.value)
            && !isValidSearchString(municipalWard.value)
            && !isValidSearchString(town.value)
            && !isValidSearchString(ruralSanitaryDistrict.value)
            && !isValidSearchString(borough.value)
            && !isValidSearchString(ecclParish.value))
            {
	          correct=false;
			  msg="\nInvalid search string";
			  street.focus();
            }		
		
		    if(!isValidMultipleWordWildcard(adminCounty.value)            ||
		       !isValidMultipleWordWildcard(civilParish.value)            ||
		       !isValidMultipleWordWildcard(municipalBorough.value)       ||
   		       !isValidMultipleWordWildcard(municipalWard.value)          ||
		       !isValidMultipleWordWildcard(town.value)                   ||
		       !isValidMultipleWordWildcard(ruralSanitaryDistrict.value)  ||
		       !isValidMultipleWordWildcard(borough.value)                ||
		       !isValidMultipleWordWildcard(ecclParish.value))
		    {
			  if(!correct)
			  {
				msg += "\n\n";
			  }
              else
              {
                if(validStreet == true)
                {
			      msg+= "Need to have at least two characters before each wildcard";
                }
              }
		
			  correct=false;
		    }
        }
	}
	else if(document.contents.rType.value==institutionSearch){
		var institutionName=document.contents.institutionName;
		var localeKeywords=document.contents.localeKeywords;
		var adminCounty=document.contents.adminCounty;
		var civilParish=document.contents.civilParish;
		var municipalBorough=document.contents.municipalBorough;
		var municipalWard=document.contents.municipalWard;
		var town=document.contents.town;
		var ruralSanitaryDistrict=document.contents.ruralSanitaryDistrict;
		var borough=document.contents.borough;
		var ecclParish=document.contents.ecclParish;
		if(!isValidSearchString(institutionName.value)){
			correct=false;
			msg+=notEntered;
			msg+="\nInstitution Name";
			institutionName.focus();
		}
		if(localeKeywords.value.toUpperCase().indexOf('NOT ') == 0){
			if(!correct){
				msg += "\n\n";
			}
			correct = false;
			msg += not;
			localeKeywords.focus();
		}
		if(!isValidWildcard(institutionName.value) ||
		!isValidWildcard(localeKeywords.value) ||
		!isValidWildcard(adminCounty.value) ||
		!isValidWildcard(civilParish.value) ||
		!isValidWildcard(municipalBorough.value) ||
		!isValidWildcard(municipalWard.value) ||
		!isValidWildcard(town.value) ||
		!isValidWildcard(ruralSanitaryDistrict.value) ||
		!isValidWildcard(borough.value) ||
		!isValidWildcard(ecclParish.value)){
			if(!correct){
				msg += "\n\n";
			}
			correct=false;
			msg+=wildcard;
			//institutionName.focus();
		}
	}
	else if(document.contents.rType.value==vesselSearch){
		var vesselName=document.contents.vesselName;
		if(!isValidSearchString(vesselName.value)){
			msg=notEntered;
			msg+="\nVessel Name";
			correct=false;
			vesselName.focus();
		}
		if(!isValidWildcard(vesselName.value)){
			if(!correct){
				msg += "\n\n";
			}
			correct=false;
			msg+=wildcard;
			vesselName.focus();
		}
	}
	else if(document.contents.rType.value==localeSearch){
		var regSubDistrict=document.contents.regSubDistrict;
		var regDistrict=document.contents.regDistrict;
		var localeKeywords=document.contents.localeKeywords;
		var adminCounty=document.contents.adminCounty;
		var civilParish=document.contents.civilParish;
		var municipalBorough=document.contents.municipalBorough;
		var municipalWard=document.contents.municipalWard;
		//var urbanSanitaryDistrict=document.contents.urbanSanitaryDistrict;
		var town=document.contents.town;
		var ruralSanitaryDistrict=document.contents.ruralSanitaryDistrict;
		var borough=document.contents.borough;
		var ecclParish=document.contents.ecclParish;
		
// DI - Issue 257/268/274 - made admin county mandatory
		if (!isValidSearchString(adminCounty.value)) {
			correct=false;
			msg="You must enter a value for Administrative County";
			localeKeywords.focus();
		}
/*
//  This seems like a waste of time now - since admin county is compulsory, this check should never complete, 
// and if it does the previous check would have caught it.
		if(!isValidSearchString(regSubDistrict.value)&&!isValidSearchString(regDistrict.value)&&!isValidSearchString(localeKeywords.value)
		&&!isValidSearchString(adminCounty.value)&&!isValidSearchString(civilParish.value)&&!isValidSearchString(municipalBorough.value)&&!isValidSearchString(municipalWard.value)
		&&!isValidSearchString(town.value)&&!isValidSearchString(ruralSanitaryDistrict.value)&&!isValidSearchString(borough.value)&&!isValidSearchString(ecclParish.value)){
			correct=false;
			msg+="At least one field must be entered";
			localeKeywords.focus();
		}
*/
		if(localeKeywords.value.toUpperCase().indexOf('NOT ') == 0){
			if(!correct){
				msg += "\n\n";
			}
			correct = false;
			msg += not;
			localeKeywords.focus();
		}
		if(!isValidWildcard(regDistrict.value) ||
		!isValidWildcard(regSubDistrict.value) ||
		!isValidWildcard(localeKeywords.value) ||
		!isValidWildcard(adminCounty.value) ||
		!isValidWildcard(civilParish.value) ||
		!isValidWildcard(municipalBorough.value) ||
		!isValidWildcard(municipalWard.value) ||
		!isValidWildcard(town.value) ||
		!isValidWildcard(ruralSanitaryDistrict.value) ||
		!isValidWildcard(borough.value) ||
		!isValidWildcard(ecclParish.value)){
			if(!correct) msg+="\n\n";
			msg+=wildcard;
			correct=false;
		}
	}
	else if(document.contents.rType.value==basicSearch||
		document.contents.rType.value==expandedSearch||
		document.contents.rType.value==expandedLocaleSearch){
		charsBeforeWildcard=document.contents.charsBeforeWildcard.value;
		
		var lastName=document.contents.lastName;
		var firstName=document.contents.firstName;
		var age=document.contents.age;
		var ageRange=document.contents.ageRange;
		var placeOfBirth=document.contents.placeOfBirth;
		var localeKeywords=document.contents.localeKeywords;
		var fName = true;
		/*if(firstName.value.length != 0){
			correct=false;
			if(newEntry){
				msg+=nameMissing;
				newEntry=false;
			}
			firstName.focus();
		}*/
		if (firstName.value.length == 0) {
			fName = false;
		}

		var lastName=document.contents.lastName;
		var lastNameEntered = false;
		if(!isValidSearchString(lastName.value) && (lastName.value.length != 0) || (lastName.value.length == 0 && !fName ) ){
			correct=false;
			if(newEntry){
				msg+=nameMissing;
				newEntry=false;
			}
			/*msg+="\nLast Name";*/
			lastName.focus();
		} else if (lastName.value.length != 0){
			lastNameEntered = true;
		}
		var ageEntered = false;
		if(age.value.length>0){
			ageEntered = true;
			if(!isDigit(age.value)){
				correct=false;
				if(!newEntry){
					msg+="\n\n";
				}
				newEntry=false;
				msg+="Age"+NAN;
				age.value="";
				age.focus();
			}
		}
		if(ageRange.value.length>0){
			if(!isDigit(ageRange.value)){
				correct=false;
				if(!newEntry){
					msg+="\n\n";
				}
				newEntry=false;
				msg+="Age Range"+NAN;
				ageRange.value="";
				ageRange.focus();
			}
			if(age.value.length<=0){
				correct=false;
				if(!newEntry){
					msg+="\n\n";
				}
				newEntry=false;
				msg+="Age must be entered for Age Range to be used";
				age.focus();
			}
		}
		if(age.value.length>0){
			var ageVal=parseInt(age.value);
			if(ageVal>200){
				correct=false;
				if(!newEntry){
					msg+="\n\n";
				}
				newEntry=false;
				msg+="An invalid age was entered";
				age.focus();
			}
		}
		
		var placeOfBirth = document.contents.placeOfBirth;
		var placeEntered = false;
		if (placeOfBirth.value.length != 0) {
			placeEntered = true;
		}
		var gender = document.contents.gender;
		var genderEntered = false;
		if(gender.options[gender.options.selectedIndex].value.length != 0){
			genderEntered = true;
		}
		
		if (!lastNameEntered && !(fName && placeEntered && ageEntered)) {
			correct=false;
			//msg += "\nIf you enter only First Name, you must also enter Age and Where Born.";
            msg += "\n" + ageMissing;
		}
		if(placeEntered && !genderEntered){
			correct = false;
			msg += "\nIf you enter Where Born, you must also enter Gender.";
		}
		if(localeKeywords.value.toUpperCase().indexOf('NOT ') == 0){
			if(!correct){
				msg += "\n\n";
			}
			correct = false;
			msg += not;
			localeKeywords.focus();
		}
		if(document.contents.rType.value==basicSearch){
			if(!isValidWildcard(lastName.value) ||
			!isValidWildcard(firstName.value) ||
			!isValidWildcard(placeOfBirth.value) ||
			!isValidWildcard(localeKeywords.value)){
				if(!correct) msg+="\n\n";
				msg+=wildcard;
				correct=false;
			}
		}
		
		if(document.contents.rType.value==expandedSearch){
			var street=document.contents.street;
			var otherName=document.contents.otherName;
			var occupation=document.contents.occupation;
			if(street.value.length>0 && localeKeywords.value.length==0){
				correct=false;
				if(!newEntry){
					msg+="\n\n";
				}
				newEntry=false;
				msg+="Place Keywords must be entered in addition to House and/or Street";
				localeKeywords.focus();
			}
			if(!isValidWildcard(lastName.value) ||
			!isValidWildcard(firstName.value) ||
			!isValidWildcard(otherName.value) ||
			!isValidWildcard(occupation.value) ||
			!isValidWildcard(placeOfBirth.value) ||
			!isValidWildcard(street.value) ||
			!isValidWildcard(localeKeywords.value)){
				if(!correct) msg+="\n\n";
				msg+=wildcard;
				correct=false;
			}
		}
		
		if(document.contents.rType.value==expandedLocaleSearch){
			var street=document.contents.street;
			var otherName=document.contents.otherName;
			var occupation=document.contents.occupation;
			var localeKeywords=document.contents.localeKeywords;
			var adminCounty=document.contents.adminCounty;
			var civilParish=document.contents.civilParish;
			var municipalBorough=document.contents.municipalBorough;
			var municipalWard=document.contents.municipalWard;
			var town=document.contents.town;
			var ruralSanitaryDistrict=document.contents.ruralSanitaryDistrict;
			var borough=document.contents.borough;
			var ecclParish=document.contents.ecclParish;
			if(street.value.length>0 && 
			localeKeywords.value.length==0 && 
			adminCounty.value.length==0 &&
			civilParish.value.length==0 &&
			municipalBorough.value.length==0 &&
			municipalWard.value.length==0 &&
			town.value.length==0 &&
			ruralSanitaryDistrict.value.length==0 &&
			borough.value.length==0 &&
			ecclParish.value.length==0){
				correct=false;
				if(!newEntry){
					msg+="\n\n";
				}
				newEntry=false;
				msg+="Place Keywords or one of the advanced address fields must be entered in addition to House and/or Street";
				localeKeywords.focus();
			}
			if(!isValidWildcard(lastName.value) ||
			!isValidWildcard(firstName.value) ||
			!isValidWildcard(otherName.value) ||
			!isValidWildcard(occupation.value) ||
			!isValidWildcard(placeOfBirth.value) ||
			!isValidWildcard(street.value) ||
			!isValidWildcard(localeKeywords.value) ||
			!isValidWildcard(adminCounty.value) ||
			!isValidWildcard(civilParish.value) ||
			!isValidWildcard(municipalBorough.value) ||
			!isValidWildcard(municipalWard.value) ||
			!isValidWildcard(town.value) ||
			!isValidWildcard(ruralSanitaryDistrict.value) ||
			!isValidWildcard(borough.value) ||
			!isValidWildcard(ecclParish.value)){
				if(!correct) msg+="\n\n";
				msg+=wildcard;
				correct=false;
			}
		}
	}
	else if(document.contents.rType.value==directSearch){
		var piece=document.contents.piece;
		var folio=document.contents.folio;
		var page=document.contents.page;
		if(!isDigit(piece.value)){
			correct=false;
			msg+="Piece"+NAN;
			piece.value="";
			piece.focus();
		}
		if(piece.value.length>0 && page.value.length>0 && folio.value.length==0){
			if(!correct) msg+="\n\n";
			correct=false;
			msg+="Folio must be entered for a page";
			folio.focus();
		}
	}

	if(correct){
		//window.status="Please wait, Searching.....";
		//document.contents.submit();
		return true;
	}
	else{
		alert(msg);
		return false;
	}
}

function submitter(type, button, srch){
    if ( type == "SUBMIT"){
        document.contents.rType.value = srch;
        document.contents.button.value = button;
        validateSearch();
    }
    else if ( type == "RESET"){
        document.contents.rType.value = srch;
        document.contents.button.value = button;
        document.contents.submit();
	}
	else if ( type == "NEXT"){
		goTo(srch);
	}
	else if ( type == "PREVIOUS"){
		goTo(srch);
	}
}

function submitImage(row, imgQuery){
	box=eval("document.contents.chooser" + row );
	if(box.options[box.selectedIndex].value!="0"){
		document.contents.action=imgQuery+box.options[box.selectedIndex].value;
		document.contents.submit();
	}
	else{
		alert("That was not a valid entry");
	}
}
function imageSelected(name, value, row){
	
	box=eval("document.contents.pageType"+value);
	if ( box.value=="true"){
		box = eval("document.images.pictures" + row );
		box.src=charge;
	}
	else{
		box = eval("document.images.pictures" + row );
		if(value==0){
			box.src=blank;
		}
		else box.src=nocharge;
	}
}
function personImageSelected(value, imageLink, scheduleLink){
	box=eval("document.contents.pageType"+value);
	if ( box.value=="true"){
		document.images.pictures.src=charge;
	}
	else{
		document.images.pictures.src=nocharge;
	}
	if ( value == 14){
		document.contents.action = imageLink;
	}
	else if (value==15){
		document.contents.action = scheduleLink;
	}
	else document.contents.action = "";
}

function goTo(url) {
    if (document.images)
        location.replace(url);
    else
        location.href = url;
}
 