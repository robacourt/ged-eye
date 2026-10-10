import { PhotoViewer } from './photoViewer.js';
import { avatarUrl, thumbUrl } from './media.js';
import { escapeHtml } from './html.js';
import { factLabel } from './factLabels.js';
import { familyOfChild, nameOf, relativeBlocked } from './familyLinks.js';

// Person notes longer than this are clamped to about NOTE_CLAMP_LINES lines behind "Show more".
const NOTE_CLAMP_LINES = 6;
const NOTE_CLAMP_CHARS = 500;

/** A fact's notes behind a native disclosure; summaryWord is "Note" or "Transcription". */
function notesDisclosure(notes, summaryWord = 'Note') {
  if (!notes?.length) return '';
  const summary = notes.length === 1 ? summaryWord : `${summaryWord}s (${notes.length})`;
  const bodies = notes.map(note => `<div class="note-text">${escapeHtml(note)}</div>`).join('');
  return `<details class="detail-notes"><summary>${escapeHtml(summary)}</summary>${bodies}</details>`;
}

/**
 * The one structure every row shares: an optional label, then the value. The label is escaped here;
 * valueHtml is already-escaped markup. With no value the label stands alone, without its colon.
 */
function labelledRow(label, valueHtml) {
  const labelHtml = label ? `<span class="detail-label">${escapeHtml(label)}${valueHtml ? ':' : ''}</span>` : '';
  const valueDiv = valueHtml ? `<div class="detail-value">${valueHtml}</div>` : '';
  return `<div class="detail-item">${labelHtml}${valueDiv}</div>`;
}

/**
 * One fact: "label: value • date • place", an optional cause, and its notes. Every field is optional.
 * The fact is data (it may be a stored object spread in); label and summaryWord are the caller's own.
 */
function factRow({ value, date, place, cause, notes }, { label, summaryWord } = {}) {
  const parts = [];
  if (value) parts.push(`<span class="detail-fact">${escapeHtml(value)}</span>`);
  if (date) parts.push(`<span class="detail-date">${escapeHtml(date)}</span>`);
  if (place) parts.push(`<span class="detail-place">${escapeHtml(place)}</span>`);
  let valueHtml = parts.join(' • ');
  if (cause) valueHtml += `<div class="detail-cause">Cause: ${escapeHtml(cause)}</div>`;
  valueHtml += notesDisclosure(notes, summaryWord);
  return labelledRow(label, valueHtml);
}

function personNote(note) {
  const long = note.length > NOTE_CLAMP_CHARS || note.split('\n').length > NOTE_CLAMP_LINES;
  if (!long) return `<div class="person-note"><div class="note-text">${escapeHtml(note)}</div></div>`;
  return `<div class="person-note"><div class="note-text note-clamped">${escapeHtml(note)}</div>` +
    '<button type="button" class="note-toggle" aria-expanded="false">Show more</button></div>';
}

// title is always a literal from the caller, never data, so it is not escaped.
function section(title, rows) {
  return rows.length ? `<div class="person-details-section"><h3>${title}</h3>${rows.join('')}</div>` : '';
}

const SEX_LABELS = new Map([['M', 'Male'], ['F', 'Female']]);

const ADD_RELATIVES = [['parent', '+ Parent'], ['spouse', '+ Spouse'], ['child', '+ Child'], ['sibling', '+ Sibling']];
let nextHintId = 0;

// The photo row shows this many thumbnails; with more photos, the last gets a "+N" for the rest.
const MAX_THUMBNAILS = 4;
// The panel's class while files are dragged over it, for editors: a dashed outline.
const DROPPING = 'person-details-dropping';

// The viewer's editor hooks and the panel options they call, each with the photo and then the person.
const VIEWER_HOOKS = [['onEdit', 'onEditPhoto'], ['onUseAsAvatar', 'onUseAsAvatar'], ['onRemove', 'onRemovePhoto']];

const CAMERA_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/></svg>';

/**
 * Whether the media Function is configured (VITE_MEDIA_API_URL). Without it nothing can be uploaded or cropped,
 * so editors get no Add tile, camera badge or drop zone (the viewer hides its own Avatar button).
 */
const mediaServiceReady = () => Boolean(import.meta.env.VITE_MEDIA_API_URL);

/**
 * The header's avatar image, or the placeholder; decorative, since the name is beside it. It is fetched with CORS,
 * as the tree (Cytoscape) fetches the same URL: the bucket sends Access-Control-Allow-Origin and Vary: Origin only
 * to requests with an Origin, so a plain fetch would cache an immutable response the tree's CORS request then
 * fails on.
 */
const avatarImage = (person) =>
  `<img class="person-avatar-image" src="${escapeHtml(avatarUrl(person))}" alt="" crossorigin="anonymous" />`;

/**
 * One photo's thumbnail, a button that opens the viewer at `index`; a document (no thumbnail) shows an icon.
 * `more` (> 0) puts "+more" over it, for the photos the row has no room for.
 */
function photoThumbnail(photo, index, more) {
  const src = thumbUrl(photo);
  const label = more > 0 ? `Photo ${index + 1}, and ${more} more` : `Photo ${index + 1}`;
  const picture = src ? `<img src="${escapeHtml(src)}" alt="" />` : '<span class="file-icon" aria-hidden="true">📄</span>';
  const overlay = more > 0 ? `<span class="person-photo-more" aria-hidden="true">+${more}</span>` : '';
  return `<button type="button" class="person-photo-thumbnail${src ? '' : ' person-photo-file'}" data-photo-index="${index}" ` +
    `aria-label="${escapeHtml(label)}">${picture}${overlay}</button>`;
}

/**
 * The editors' controls, when `canEdit`: each control gets a `data-edit-action` index into `actions`, and
 * showPerson() wires the clicks once the HTML is in place. Every label is escaped here.
 */
class EditControls {
  constructor(person, relationships, hooks) {
    this.person = person;
    this.relationships = relationships;
    this.hooks = hooks;
    this.actions = [];
  }

  /** A button that runs `run` when clicked. `text` and `label` are escaped; `className` is a literal. */
  button(className, text, label, run, options = {}) {
    return this.control(className, escapeHtml(text), label, run, options);
  }

  /** A button holding `contentHtml`, already-escaped markup, that runs `run`; `label` is escaped. */
  control(className, contentHtml, label, run, { disabled = false, describedBy = null } = {}) {
    this.actions.push(run);
    const attributes = [
      `type="button"`, `class="${className}"`, `data-edit-action="${this.actions.length - 1}"`,
      label ? `aria-label="${escapeHtml(label)}"` : '', disabled ? 'disabled' : '',
      describedBy ? `aria-describedby="${describedBy}"` : ''
    ].filter(Boolean);
    return `<button ${attributes.join(' ')}>${contentHtml}</button>`;
  }

  call(name, ...args) {
    this.hooks[name]?.(...args, this.person);
  }

  unlink(relation, personId, familyId, name) {
    const what = { parent: 'a parent', spouse: 'the spouse', child: 'a child' }[relation];
    const target = { relation, role: relation === 'child' ? 'child' : 'partner', personId, familyId };
    return this.button('details-unlink', '×', `Remove ${name} as ${what}`, () => this.call('onUnlink', target));
  }

  /** The Edit button in the header. */
  editPerson() {
    return this.button('details-edit-person', 'Edit', `Edit ${nameOf(this.person)}`, () => this.hooks.onEdit?.(this.person));
  }

  /** The header's avatar as a button, with a camera badge, that opens Change avatar. */
  avatarButton() {
    const content = `${avatarImage(this.person)}<span class="person-avatar-badge" aria-hidden="true">${CAMERA_ICON}</span>`;
    return this.control('person-avatar person-avatar-button', content, `Change avatar for ${nameOf(this.person)}`,
      () => this.call('onChangeAvatar'));
  }

  /**
   * The Add tile at the end of the photo row. Its click calls onAddPhotos straight away, inside the tap, so the
   * sheet can open the file picker (iOS opens one only from there).
   */
  addPhotosTile() {
    const content = '<span class="person-photo-add-plus" aria-hidden="true">+</span><span class="person-photo-add-text">Add</span>';
    return this.control('person-photo-add', content, `Add photos for ${nameOf(this.person)}`, () => this.call('onAddPhotos'));
  }

  /** The viewer's editor hooks, for the options given: each calls the panel's with the photo and this person. */
  viewerHooks() {
    const hooks = {};
    for (const [hook, option] of VIEWER_HOOKS) {
      if (typeof this.hooks[option] === 'function') hooks[hook] = (photo) => this.call(option, photo);
    }
    return hooks;
  }

  /** Edit and × for a marriage row, whose spouse is shown as `spouseName`; × only when there is a spouse. */
  marriageActions(marriage, spouse, spouseName) {
    const partners = [{ id: this.person.id, name: this.person.name ?? '' }];
    if (marriage.spouseId) partners.push({ id: marriage.spouseId, name: spouse ? spouse.name ?? '' : spouseName });
    const family = {
      familyId: marriage.familyId, partners,
      marriageDate: marriage.marriageDate ?? null, marriagePlace: marriage.marriagePlace ?? null,
      divorceDate: marriage.divorceDate ?? null, divorcePlace: marriage.divorcePlace ?? null
    };
    const label = `Edit the marriage of ${partners.map(nameOf).join(' and ')}`;
    const edit = this.button('details-edit-family', 'Edit', label, () => this.call('onEditFamily', family));
    const remove = marriage.spouseId ? this.unlink('spouse', marriage.spouseId, marriage.familyId, spouseName) : '';
    return `<span class="details-row-actions">${edit}${remove}</span>`;
  }

  /** The Family section: parents and children with ×, the + relative buttons, and the History link. */
  familySection() {
    const rows = [];
    const byId = new Map((this.relationships?.parents ?? []).map(parent => [parent.id, parent]));
    for (const family of this.person.parentFamilies ?? []) {
      for (const parentId of family.partnerIds ?? []) {
        const name = nameOf(byId.get(parentId));
        rows.push(labelledRow('Parent', `<strong>${escapeHtml(name)}</strong>` +
          `<span class="details-row-actions">${this.unlink('parent', parentId, family.familyId, name)}</span>`));
      }
    }
    for (const child of this.relationships?.children ?? []) {
      // familyId is null when the view can't say which family the child is in: the confirmation then explains.
      const remove = this.unlink('child', child.id, familyOfChild(this.person, child), nameOf(child));
      rows.push(labelledRow('Child', `<strong>${escapeHtml(nameOf(child))}</strong><span class="details-row-actions">${remove}</span>`));
    }

    const hints = [];
    const buttons = ADD_RELATIVES.map(([relation, text]) => {
      const blocked = relativeBlocked(this.person, relation);
      let describedBy = null;
      if (blocked) {
        describedBy = `details-add-hint-${++nextHintId}`;
        hints.push(`<p class="details-add-hint" id="${describedBy}">${escapeHtml(blocked)}</p>`);
      }
      return this.button('details-add', text, null, () => this.call('onAddRelative', relation), { disabled: Boolean(blocked), describedBy });
    });

    return '<div class="person-details-section details-family"><h3>Family</h3>' + rows.join('') +
      `<div class="details-add-relatives">${buttons.join('')}</div>${hints.join('')}` +
      `<div class="details-history-row">${this.button('details-history', 'History of this person', null, () => this.hooks.onShowHistory?.(this.person))}</div>` +
      '</div>';
  }

  /** Wires every control rendered into `root`. */
  wire(root) {
    root.querySelectorAll('[data-edit-action]').forEach(control => {
      const run = this.actions[Number(control.dataset.editAction)];
      control.addEventListener('click', () => run?.());
    });
  }
}

// Occupations were plain strings before the 2026-10 facts backfill.
const asFact = (entry) => (typeof entry === 'string' ? { value: entry } : entry);

/**
 * Person details panel component
 */
export class PersonDetails {
  constructor(containerElement) {
    this.container = containerElement;
    this.currentPerson = null;
    this.photoViewer = new PhotoViewer();
    this.onDropFiles = null; // (files) → void while an editor can drop files on the panel, else null
    this.dragDepth = 0;
    this.createPanel();
    this.listenForDrops();
  }

  createPanel() {
    this.container.innerHTML = `
      <div class="person-details">
        <div class="person-details-content">
          <div class="person-details-empty">
            Select a person to view their details
          </div>
        </div>
      </div>
    `;

    this.panel = this.container.querySelector('.person-details');
    this.content = this.container.querySelector('.person-details-content');
    this.emptyState = this.container.querySelector('.person-details-empty');
  }

  /**
   * Files dragged over the panel, while `onDropFiles` is set (for editors): outlined while over it, and added
   * when dropped. The listeners stay for the panel's life; each render only changes `onDropFiles`. Drags of
   * anything but files, and every drag for viewers, are left to the browser.
   */
  listenForDrops() {
    const accepts = (event) => Boolean(this.onDropFiles) && Array.from(event.dataTransfer?.types ?? []).includes('Files');
    // Entering a child fires before leaving its parent, so the outline goes only once every enter has left.
    this.panel.addEventListener('dragenter', (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      this.dragDepth++;
      this.panel.classList.add(DROPPING);
    });
    this.panel.addEventListener('dragover', (event) => {
      if (!accepts(event)) return;
      event.preventDefault(); // allows the drop
      event.dataTransfer.dropEffect = 'copy';
      this.panel.classList.add(DROPPING);
    });
    this.panel.addEventListener('dragleave', (event) => {
      if (!accepts(event)) return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.panel.classList.remove(DROPPING);
    });
    this.panel.addEventListener('drop', (event) => {
      if (!accepts(event)) return;
      event.preventDefault(); // instead of the browser opening the file
      const add = this.onDropFiles;
      this.endDrag();
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length > 0) add(files);
    });
  }

  endDrag() {
    this.dragDepth = 0;
    this.panel.classList.remove(DROPPING);
  }

  /**
   * Display details for a person.
   * @param options  for everyone: `{ onOpenPerson(personId) }`, for the photo viewer's "Shown for" links.
   *   For editors also: `{ canEdit, onEdit(person), onAddRelative(relation, person),
   *   onUnlink({ relation, role, personId, familyId }, person), onEditFamily(family, person), onShowHistory(person),
   *   onAddPhotos(person, files?), onChangeAvatar(person), onEditPhoto(photo, person), onUseAsAvatar(photo, person),
   *   onRemovePhoto(photo, person) }`.
   *   Without `canEdit` no edit control is rendered. `relation` is 'parent' | 'spouse' | 'child' | 'sibling';
   *   onUnlink's `familyId` is null for a child whose family an older view can't tell (unlinkConfirm explains);
   *   `family` is openFamilyEditor's `{ familyId, partners: [{ id, name }], marriageDate, marriagePlace,
   *   divorceDate, divorcePlace }`. onAddPhotos is called inside the Add tile's click, with no files (the sheet
   *   opens the file picker), or with the files dropped on the panel. The photo hooks are the viewer's editor
   *   hooks, called after it has closed; `photo` is one of person_record's `photos`.
   *   Without VITE_MEDIA_API_URL there is no Add tile, camera badge or drop zone.
   */
  async showPerson(personData, relationships = null, options = {}) {
    // The viewer's buttons act for the person shown: going on to someone else closes it.
    if (this.photoViewer.isOpen && this.currentPerson?.id !== personData.id) this.photoViewer.hide();
    this.currentPerson = personData;
    this.relationships = relationships;
    this.emptyState.style.display = 'none';
    const edit = options?.canEdit ? new EditControls(personData, relationships, options) : null;
    const canUpload = Boolean(edit) && mediaServiceReady();

    // Reset scroll position to top
    this.content.scrollTop = 0;

    const sexLabel = SEX_LABELS.get(personData.sex);
    const avatar = canUpload ? edit.avatarButton() : `<span class="person-avatar">${avatarImage(personData)}</span>`;
    let html = `
      <div class="person-details-header">
        ${avatar}
        <h2>${escapeHtml(personData.name || 'Unknown')}</h2>
        ${sexLabel ? `<span class="person-sex">${sexLabel}</span>` : ''}
        ${edit ? edit.editPerson() : ''}
      </div>
    `;

    // Up to 4 thumbnails, the 4th with "+N" when there are more; editors who can upload also get the Add tile,
    // even when there are no photos yet.
    const photos = personData.photos ?? [];
    if (photos.length > 0 || canUpload) {
      const more = photos.length - MAX_THUMBNAILS;
      const thumbnails = photos.slice(0, MAX_THUMBNAILS)
        .map((photo, i) => photoThumbnail(photo, i, i === MAX_THUMBNAILS - 1 ? more : 0));
      const row = canUpload ? 'person-photos-row person-photos-row-editing' : 'person-photos-row';
      html += `<div class="${row}">${thumbnails.join('')}${canUpload ? edit.addPhotosTile() : ''}</div>`;
    }

    html += '<div class="person-details-sections">';

    const lifeEvents = [
      { label: 'Birth', date: personData.birthDate, place: personData.birthPlace, notes: personData.birthNotes },
      { label: 'Baptism', date: personData.baptismDate, place: personData.baptismPlace, notes: personData.baptismNotes },
      { label: 'Death', date: personData.deathDate, place: personData.deathPlace, notes: personData.deathNotes, cause: personData.causeOfDeath },
      { label: 'Burial', date: personData.burialDate, place: personData.burialPlace, notes: personData.burialNotes }
    ].filter(event => event.date || event.place || event.notes?.length || event.cause);
    html += section('Life Events', lifeEvents.map(event => factRow(event, { label: event.label })));

    if (personData.marriages?.length && this.relationships?.spouses) {
      const rows = [];
      for (const marriage of personData.marriages) {
        const spouse = this.relationships.spouses.find(s => s.id === marriage.spouseId);
        // "Unknown" when no spouse is recorded; a spouse without a name is "Unnamed person", as everywhere else.
        const spouseName = spouse ? nameOf(spouse) : 'Unknown';
        const actions = edit ? edit.marriageActions(marriage, spouse, spouseName) : '';
        rows.push(labelledRow('Spouse', `<strong>${escapeHtml(spouseName)}</strong>${actions}`));
        if (marriage.marriageDate || marriage.marriagePlace) {
          rows.push(factRow({ date: marriage.marriageDate, place: marriage.marriagePlace }, { label: 'Married' }));
        }
        if (marriage.divorceDate || marriage.divorcePlace) {
          rows.push(factRow({ date: marriage.divorceDate, place: marriage.divorcePlace }, { label: 'Divorced' }));
        }
      }
      html += section('Marriages', rows);
    }

    if (edit) html += edit.familySection();

    html += section('Occupations', (personData.occupations ?? []).map(entry => factRow(asFact(entry))));

    const otherRows = (personData.otherFacts ?? []).map(fact => factRow(fact, { label: factLabel(fact) }));
    if (personData.religion) otherRows.push(factRow({ value: personData.religion }, { label: 'Religion' }));
    if (personData.education) otherRows.push(factRow({ value: personData.education }, { label: 'Education' }));
    html += section('Other details', otherRows);

    html += section('Census Records', (personData.censusRecords ?? []).map(census => factRow(census, { summaryWord: 'Transcription' })));
    html += section('Residences', (personData.residences ?? []).map(residence => factRow(residence)));
    html += section('Notes', (personData.notes ?? []).map(personNote));

    const contact = [];
    if (personData.email) {
      contact.push(labelledRow('Email', `<a href="mailto:${escapeHtml(personData.email)}">${escapeHtml(personData.email)}</a>`));
    }
    if (personData.phone) {
      contact.push(labelledRow('Phone', `<a href="tel:${escapeHtml(personData.phone)}">${escapeHtml(personData.phone)}</a>`));
    }
    html += section('Contact', contact);

    html += '</div>'; // Close sections

    this.content.innerHTML = html;
    edit?.wire(this.content);

    this.endDrag();
    this.onDropFiles = canUpload && typeof options.onAddPhotos === 'function'
      ? (files) => options.onAddPhotos(personData, files)
      : null;
    this.photoViewer.onOpenPerson = typeof options?.onOpenPerson === 'function' ? options.onOpenPerson : null;
    this.photoViewer.setEditorHooks(edit ? edit.viewerHooks() : null);

    // Add click handlers to photo thumbnails
    const thumbnails = this.content.querySelectorAll('.person-photo-thumbnail');
    thumbnails.forEach(thumbnail => {
      thumbnail.addEventListener('click', () => {
        const photoIndex = parseInt(thumbnail.getAttribute('data-photo-index'));
        this.openPhotoViewer(photoIndex);
      });
    });

    // A note that is long by the rules above may still fit in the clamped box (wide panel, few wrapped
    // lines). Those need no clamp or button. A height of 0 means nothing has been laid out (jsdom, or a
    // panel that is not displayed), so the note is left as rendered.
    this.content.querySelectorAll('.note-clamped').forEach(text => {
      if (text.clientHeight && text.scrollHeight <= text.clientHeight + 1) {
        text.classList.remove('note-clamped');
        text.parentElement.querySelector('.note-toggle')?.remove();
      }
    });

    this.content.querySelectorAll('.note-toggle').forEach(button => {
      button.addEventListener('click', () => {
        const text = button.parentElement.querySelector('.note-text');
        const expanded = !text.classList.toggle('note-clamped');
        button.textContent = expanded ? 'Show less' : 'Show more';
        button.setAttribute('aria-expanded', String(expanded));
        // Collapsing a long note can leave the page scrolled past its start.
        if (!expanded) text.scrollIntoView?.({ block: 'nearest' });
      });
    });
  }

  /**
   * Open photo viewer at a specific photo index
   */
  openPhotoViewer(startIndex = 0) {
    if (!this.currentPerson || !this.currentPerson.photos || this.currentPerson.photos.length === 0) {
      return;
    }
    this.photoViewer.open(this.currentPerson.name, this.currentPerson.photos, startIndex);
  }

  /**
   * Clear the details panel
   */
  clear() {
    this.currentPerson = null;
    this.onDropFiles = null;
    this.endDrag();
    this.photoViewer.setEditorHooks(null);
    this.content.innerHTML = '';
    this.emptyState.style.display = 'flex';
  }
}
