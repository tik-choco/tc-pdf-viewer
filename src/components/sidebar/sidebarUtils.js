import { scheduleDriveExport } from '../../services/driveExport.js';

export const DEFAULT_FOLDER = 'Default';

export const getFileFolder = (file) => file.folder || DEFAULT_FOLDER;

export function getAllFolders(customFolders, pdfs) {
    return Array.from(new Set([
        ...customFolders,
        ...pdfs.map(getFileFolder),
    ]));
}

export function renameFolderInList(folders, oldName, newName) {
    return Array.from(new Set(
        folders.map((folder) => folder === oldName ? newName : folder)
    ));
}

export function reorderFolderBefore(folders, draggedFolder, targetFolder) {
    if (!draggedFolder || draggedFolder === targetFolder) return folders;

    const nextFolders = [...folders];
    const sourceIndex = nextFolders.indexOf(draggedFolder);
    const targetIndex = nextFolders.indexOf(targetFolder);
    if (sourceIndex === -1 || targetIndex === -1) return folders;

    const [sourceFolder] = nextFolders.splice(sourceIndex, 1);
    const nextTargetIndex = nextFolders.indexOf(targetFolder);
    nextFolders.splice(nextTargetIndex, 0, sourceFolder);

    return nextFolders;
}

export function moveFileToFolder(pdfs, fileName, targetFolder) {
    const nextPdfs = [...pdfs];
    const sourceIndex = nextPdfs.findIndex((file) => file.name === fileName);
    if (sourceIndex === -1) return pdfs;

    const [sourceFile] = nextPdfs.splice(sourceIndex, 1);
    const movedFile = { ...sourceFile, folder: targetFolder };
    let lastTargetIndex = -1;

    for (let i = nextPdfs.length - 1; i >= 0; i--) {
        if (getFileFolder(nextPdfs[i]) === targetFolder) {
            lastTargetIndex = i;
            break;
        }
    }

    if (lastTargetIndex === -1) {
        nextPdfs.push(movedFile);
    } else {
        nextPdfs.splice(lastTargetIndex + 1, 0, movedFile);
    }

    return nextPdfs;
}

export function reorderFile(pdfs, draggedFileName, targetFileName, position = 'before') {
    if (!draggedFileName || draggedFileName === targetFileName) return pdfs;

    const nextPdfs = [...pdfs];
    const sourceIndex = nextPdfs.findIndex((file) => file.name === draggedFileName);
    const targetFile = nextPdfs.find((file) => file.name === targetFileName);
    if (sourceIndex === -1 || !targetFile) return pdfs;

    const [sourceFile] = nextPdfs.splice(sourceIndex, 1);
    const targetIndex = nextPdfs.findIndex((file) => file.name === targetFileName);
    const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
    nextPdfs.splice(insertIndex, 0, {
        ...sourceFile,
        folder: getFileFolder(targetFile),
    });

    return nextPdfs;
}

export function persistCustomFolders(folders) {
    localStorage.setItem('mist_custom_folders', JSON.stringify(folders));
    scheduleDriveExport();
}
