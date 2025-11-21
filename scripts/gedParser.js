/**
 * Simple GEDCOM parser
 */

export function parseGedcom(gedcomText) {
  const lines = gedcomText.split('\n');
  const individuals = new Map();
  const families = new Map();

  let currentRecord = null;
  let currentLevel = -1;
  let currentParent = null;
  let stack = []; // Stack to track nested structures

  for (let line of lines) {
    line = line.trim();  // Remove \r\n and whitespace
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(@[^@]+@\s+)?(.+)$/);
    if (!match) continue;

    const level = parseInt(match[1]);
    const tag = match[3].split(' ')[0];
    const value = match[3].substring(tag.length).trim();

    // Handle record start (level 0)
    if (level === 0) {
      if (tag === 'HEAD' || tag === 'TRLR') {
        currentRecord = null;
        continue;
      }

      const id = match[2]?.trim().replace(/@/g, '');

      if (tag === 'INDI') {
        currentRecord = { id, type: 'INDI', data: {} };
        individuals.set(id, currentRecord);
        stack = [currentRecord.data];
      } else if (tag === 'FAM') {
        currentRecord = { id, type: 'FAM', data: {} };
        families.set(id, currentRecord);
        stack = [currentRecord.data];
      }
      currentLevel = 0;
      continue;
    }

    if (!currentRecord) continue;

    // Maintain stack based on level
    while (stack.length > level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];

    // Store data
    if (tag === 'NAME') {
      parent.NAME = value;
    } else if (tag === 'SEX') {
      parent.SEX = value;
    } else if (tag === 'DATE') {
      parent.DATE = value;
    } else if (tag === 'PLAC') {
      parent.PLAC = value;
    } else if (tag === 'FILE') {
      if (!parent.FILES) parent.FILES = [];
      parent.FILES.push(value);
    } else if (tag === 'NOTE') {
      if (!parent.NOTE) parent.NOTE = [];
      parent.NOTE.push(value);
    } else if (tag === 'OCCU') {
      if (!parent.OCCU) parent.OCCU = [];
      parent.OCCU.push(value);
    } else if (tag === 'EMAIL') {
      parent.EMAIL = value;
    } else if (tag === 'PHON') {
      parent.PHON = value;
    } else if (tag === 'BIRT') {
      parent.BIRT = {};
      stack.push(parent.BIRT);
    } else if (tag === 'DEAT') {
      parent.DEAT = {};
      stack.push(parent.DEAT);
    } else if (tag === 'BAPM') {
      parent.BAPM = {};
      stack.push(parent.BAPM);
    } else if (tag === 'BURI') {
      parent.BURI = {};
      stack.push(parent.BURI);
    } else if (tag === 'CENS') {
      if (!parent.CENS) parent.CENS = [];
      const censusRecord = {};
      parent.CENS.push(censusRecord);
      stack.push(censusRecord);
    } else if (tag === 'RESI') {
      if (!parent.RESI) parent.RESI = [];
      const residenceRecord = {};
      parent.RESI.push(residenceRecord);
      stack.push(residenceRecord);
    } else if (tag === 'OBJE') {
      const obj = {};
      if (!parent.OBJE) parent.OBJE = [];
      parent.OBJE.push(obj);
      stack.push(obj);
    } else if (tag === 'FAMS') {
      if (!parent.FAMS) parent.FAMS = [];
      parent.FAMS.push(value.replace(/@/g, ''));
    } else if (tag === 'FAMC') {
      if (!parent.FAMC) parent.FAMC = [];
      parent.FAMC.push(value.replace(/@/g, ''));
    } else if (tag === 'HUSB') {
      parent.HUSB = value.replace(/@/g, '');
    } else if (tag === 'WIFE') {
      parent.WIFE = value.replace(/@/g, '');
    } else if (tag === 'CHIL') {
      if (!parent.CHIL) parent.CHIL = [];
      parent.CHIL.push(value.replace(/@/g, ''));
    }
  }

  return { individuals, families };
}

export function extractPersonData(parsedGed, personId) {
  const individual = parsedGed.individuals.get(personId);
  if (!individual) return null;

  const data = individual.data;

  // Parse name
  const nameParts = (data.NAME || '').match(/([^/]*)\s*\/([^/]*)\//);
  const givenName = nameParts?.[1]?.trim() || '';
  const surname = nameParts?.[2]?.trim() || '';
  const name = `${givenName} ${surname}`.trim();

  // Extract photos - convert Windows paths to relative paths
  const photos = [];
  if (data.OBJE) {
    for (const obj of data.OBJE) {
      if (obj.FILES) {
        photos.push(...obj.FILES.map(convertPath));
      }
    }
  }

  // Get spouses and children from families where this person is a parent
  const spouseIds = [];
  const childIds = [];

  if (data.FAMS) {
    for (const famId of data.FAMS) {
      const family = parsedGed.families.get(famId);
      if (!family) continue;

      const famData = family.data;

      // Add spouse
      if (famData.HUSB && famData.HUSB !== personId) {
        spouseIds.push(famData.HUSB);
      }
      if (famData.WIFE && famData.WIFE !== personId) {
        spouseIds.push(famData.WIFE);
      }

      // Add children
      if (famData.CHIL) {
        childIds.push(...famData.CHIL);
      }
    }
  }

  // Get parents from families where this person is a child
  const parentIds = [];

  if (data.FAMC) {
    for (const famId of data.FAMC) {
      const family = parsedGed.families.get(famId);
      if (!family) continue;

      const famData = family.data;
      if (famData.HUSB) parentIds.push(famData.HUSB);
      if (famData.WIFE) parentIds.push(famData.WIFE);
    }
  }

  // Build the result object with all available data
  const result = {
    id: personId,
    name,
    givenName,
    surname,
    sex: data.SEX || null,
    birthDate: data.BIRT?.DATE || null,
    birthPlace: data.BIRT?.PLAC || null,
    deathDate: data.DEAT?.DATE || null,
    deathPlace: data.DEAT?.PLAC || null,
    photos,
    spouseIds,
    childIds,
    parentIds
  };

  // Add optional fields if they exist
  if (data.BAPM?.DATE) result.baptismDate = data.BAPM.DATE;
  if (data.BAPM?.PLAC) result.baptismPlace = data.BAPM.PLAC;

  if (data.BURI?.DATE) result.burialDate = data.BURI.DATE;
  if (data.BURI?.PLAC) result.burialPlace = data.BURI.PLAC;

  if (data.OCCU && data.OCCU.length > 0) result.occupations = data.OCCU;

  if (data.NOTE && data.NOTE.length > 0) result.notes = data.NOTE;

  if (data.EMAIL) result.email = data.EMAIL;
  if (data.PHON) result.phone = data.PHON;

  // Census records
  if (data.CENS && data.CENS.length > 0) {
    result.censusRecords = data.CENS.map(cens => ({
      date: cens.DATE || null,
      place: cens.PLAC || null
    })).filter(c => c.date || c.place);
  }

  // Residences
  if (data.RESI && data.RESI.length > 0) {
    result.residences = data.RESI.map(resi => ({
      date: resi.DATE || null,
      place: resi.PLAC || null
    })).filter(r => r.date || r.place);
  }

  return result;
}

function convertPath(windowsPath) {
  // Convert C:\Brother's Keeper 7\Data\Media\... to Data/Media/...
  // Convert C:\Brother's Keeper 7\Data\Picture\... to Data/Picture/...
  const match = windowsPath.match(/Data[\\\/](Media|Picture)[\\\/].+$/i);
  if (match) {
    return match[0].replace(/\\/g, '/');
  }
  // Handle relative paths that are already just filenames
  return windowsPath.replace(/\\/g, '/');
}
