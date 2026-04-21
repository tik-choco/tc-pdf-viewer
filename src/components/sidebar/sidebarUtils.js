export const DEFAULT_FOLDER = 'Default';

export const getFileFolder = (file) => file.folder || DEFAULT_FOLDER;

export function getAllFolders(customFolders, pdfs) {
    return Array.from(new Set([
        ...customFolders,
        ...pdfs.map(getFileFolder),
    ]));
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

export function reorderFileBefore(pdfs, draggedFileName, targetFileName) {
    if (!draggedFileName || draggedFileName === targetFileName) return pdfs;

    const nextPdfs = [...pdfs];
    const sourceIndex = nextPdfs.findIndex((file) => file.name === draggedFileName);
    const targetFile = nextPdfs.find((file) => file.name === targetFileName);
    if (sourceIndex === -1 || !targetFile) return pdfs;

    const [sourceFile] = nextPdfs.splice(sourceIndex, 1);
    const targetIndex = nextPdfs.findIndex((file) => file.name === targetFileName);
    nextPdfs.splice(targetIndex, 0, {
        ...sourceFile,
        folder: getFileFolder(targetFile),
    });

    return nextPdfs;
}

export function persistCustomFolders(folders) {
    localStorage.setItem('mist_custom_folders', JSON.stringify(folders));
}
