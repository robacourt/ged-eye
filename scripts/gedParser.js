/**
 * GEDCOM parser, stage 2: INDI and FAM records with the `data` the import reads, plus each
 * record's node tree (stage 1, scripts/gedTree.js) for the facts.
 */
import { parseGedcomTree, lastChild, text } from './gedTree.js';
import { individualFacts } from './gedFacts.js';

export { parseGedcomTree };

const pointer = (node) => text(node).replace(/@/g, '');

// Level-1 tags whose subtree the legacy parser kept to itself, so an OBJE inside never became a photo.
const NO_PHOTO_TAGS = new Set(['BIRT', 'BAPM', 'DEAT', 'BURI', 'CENS', 'RESI', 'MARR', 'DIV']);

function eventData(node) {
  const out = {};
  const date = lastChild(node, 'DATE');
  const place = lastChild(node, 'PLAC');
  if (date) out.DATE = text(date);
  if (place) out.PLAC = text(place);
  return out;
}

function firstDescendant(node, tag) {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = firstDescendant(child, tag);
    if (found) return found;
  }
  return null;
}

/**
 * The OBJE nodes the legacy parser treated as photos: each level-1 OBJE, plus the first OBJE
 * anywhere under any other level-1 node it opened no frame for (in practice an OBJE on a source
 * citation of an EVEN, OCCU or _MILT). That OBJE stayed open on the legacy stack until the next
 * level-1 line, so later OBJEs in the same subtree nested inside it and were not photos.
 */
function photoNodes(indi) {
  const out = [];
  for (const child of indi.children) {
    if (child.tag === 'OBJE') {
      out.push(child);
    } else if (!NO_PHOTO_TAGS.has(child.tag)) {
      const obje = firstDescendant(child, 'OBJE');
      if (obje) out.push(obje);
    }
  }
  return out;
}

function individualData(node) {
  const data = {};
  for (const child of node.children) {
    switch (child.tag) {
      case 'NAME': case 'SEX': case 'EMAIL': case 'PHON':
        data[child.tag] = text(child);
        break;
      case 'BIRT': case 'DEAT': case 'BAPM': case 'BURI':
        data[child.tag] = eventData(child);
        break;
      case 'FAMS': case 'FAMC':
        (data[child.tag] ??= []).push(pointer(child));
        break;
    }
  }
  const photos = photoNodes(node).map(obje => {
    const files = obje.children.filter(child => child.tag === 'FILE').map(text);
    return files.length ? { FILES: files } : {};
  });
  if (photos.length) data.OBJE = photos;
  return data;
}

function familyData(node) {
  const data = {};
  for (const child of node.children) {
    switch (child.tag) {
      case 'HUSB': case 'WIFE':
        data[child.tag] = pointer(child);
        break;
      case 'CHIL':
        (data.CHIL ??= []).push(pointer(child));
        break;
      case 'MARR': case 'DIV':
        data[child.tag] = eventData(child);
        break;
    }
  }
  return data;
}

export function parseGedcom(gedcomText) {
  const individuals = new Map();
  const families = new Map();
  for (const node of parseGedcomTree(gedcomText)) {
    if (node.tag === 'INDI') {
      individuals.set(node.xref, { id: node.xref, type: 'INDI', data: individualData(node), node });
    } else if (node.tag === 'FAM') {
      families.set(node.xref, { id: node.xref, type: 'FAM', data: familyData(node), node });
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
  const marriages = [];

  if (data.FAMS) {
    for (const famId of data.FAMS) {
      const family = parsedGed.families.get(famId);
      if (!family) continue;

      const famData = family.data;

      // Determine spouse ID
      let spouseId = null;
      if (famData.HUSB && famData.HUSB !== personId) {
        spouseId = famData.HUSB;
        spouseIds.push(spouseId);
      }
      if (famData.WIFE && famData.WIFE !== personId) {
        spouseId = famData.WIFE;
        spouseIds.push(spouseId);
      }

      // Add marriage information
      const marriage = {
        spouseId: spouseId,
        familyId: famId
      };

      if (famData.MARR?.DATE) marriage.marriageDate = famData.MARR.DATE;
      if (famData.MARR?.PLAC) marriage.marriagePlace = famData.MARR.PLAC;
      if (famData.DIV?.DATE) marriage.divorceDate = famData.DIV.DATE;
      if (famData.DIV?.PLAC) marriage.divorcePlace = famData.DIV.PLAC;

      marriages.push(marriage);

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

  if (data.EMAIL) result.email = data.EMAIL;
  if (data.PHON) result.phone = data.PHON;

  // Marriages
  if (marriages.length > 0) {
    result.marriages = marriages;
  }

  // Notes, occupations, census records, residences, life-event notes and other facts
  Object.assign(result, individualFacts(individual.node));

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
