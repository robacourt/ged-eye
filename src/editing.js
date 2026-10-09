/**
 * The editing UI, with its stylesheet: the editors' dialogs, History and Editors. main.js imports this on
 * demand, once someone signed in can edit, so viewers never download it.
 */
import './editingStyles.css';

export { openPersonEditor } from './personEditor.js';
export { openFamilyEditor } from './familyEditor.js';
export { openRelativeDialog } from './relativeDialog.js';
export { openUnlinkConfirm } from './unlinkConfirm.js';
export { openHistoryPanel } from './historyPanel.js';
export { openEditorsDialog } from './editorsDialog.js';
export { isEditorDialogOpen } from './editorDialog.js';
