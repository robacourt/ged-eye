/**
 * The editing UI, with its stylesheet: the editors' dialogs, History, Editors and the photo dialogs (Add photos,
 * Change avatar with its cropper, the photo editor), plus the media client and upload queue they use. main.js
 * imports this on demand, once someone signed in can edit, so viewers never download any of it.
 */
import './editingStyles.css';

export { openPersonEditor } from './personEditor.js';
export { openFamilyEditor } from './familyEditor.js';
export { openRelativeDialog } from './relativeDialog.js';
export { openUnlinkConfirm } from './unlinkConfirm.js';
export { openHistoryPanel } from './historyPanel.js';
export { openEditorsDialog } from './editorsDialog.js';
export { isEditorDialogOpen, commandErrorMessage } from './editorDialog.js';
export { openAddPhotosDialog } from './addPhotosDialog.js';
export { openAvatarDialog } from './avatarDialog.js';
export { openPhotoEditDialog } from './photoEditDialog.js';
export { createUploadQueue } from './uploadQueue.js';
export { removePhotoParams } from './photoParams.js';
/** The media Function's client (mediaApi.js): `{ requestUpload, uploadFile, processUpload, discardUpload, renderAvatar }`. */
export * as mediaApi from './mediaApi.js';
