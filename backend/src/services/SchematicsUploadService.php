<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;

final class SchematicsUploadService
{
    /** @var list<string> */
    private const ALLOWED_EXTENSIONS = ['schematic', 'litematic', 'bp', 'schem'];

    public function __construct(
        private readonly string $uploadDir,
        private readonly int $maxBytes
    ) {
    }

    /**
     * @param array<string, mixed> $file
     * @return array{filename: string, path: string, size: int, bytesWritten: int}
     */
    public function store(array $file, string $uploadedByUserId): array
    {
        $error = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($error !== UPLOAD_ERR_OK) {
            throw new HttpException($this->uploadErrorMessage($error), 422);
        }

        $tmpPath = (string) ($file['tmp_name'] ?? '');
        if ($tmpPath === '' || !is_uploaded_file($tmpPath)) {
            throw new HttpException('Fichier invalide', 422);
        }

        $size = (int) ($file['size'] ?? 0);
        if ($size <= 0) {
            throw new HttpException('Fichier vide', 422);
        }

        if ($size > $this->maxBytes) {
            throw new HttpException(
                sprintf('Fichier trop volumineux (max %d Mo)', (int) ceil($this->maxBytes / 1024 / 1024)),
                413
            );
        }

        $originalName = (string) ($file['name'] ?? '');
        $filename = $this->sanitizeFilename($originalName);
        $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        if (!in_array($extension, self::ALLOWED_EXTENSIONS, true)) {
            throw new HttpException(
                'Extension non autorisee. Formats acceptes: .schematic, .litematic, .bp, .schem',
                422
            );
        }

        $targetDir = rtrim($this->uploadDir, '/\\');
        if (!is_dir($targetDir) && !mkdir($targetDir, 0755, true) && !is_dir($targetDir)) {
            throw new HttpException('Repertoire de destination inaccessible', 500);
        }

        if (!is_writable($targetDir)) {
            throw new HttpException('Repertoire de destination non inscriptible', 500);
        }

        $targetPath = $targetDir . DIRECTORY_SEPARATOR . $filename;

        if (!move_uploaded_file($tmpPath, $targetPath)) {
            throw new HttpException('Impossible d enregistrer le fichier sur le serveur', 500);
        }

        @chmod($targetPath, 0644);

        return [
            'filename' => $filename,
            'path' => $targetPath,
            'size' => $size,
            'bytesWritten' => $size,
            'uploadedBy' => $uploadedByUserId,
        ];
    }

    /**
     * @return list<string>
     */
    public function allowedExtensions(): array
    {
        return self::ALLOWED_EXTENSIONS;
    }

    public function maxBytes(): int
    {
        return $this->maxBytes;
    }

    public function uploadDir(): string
    {
        return $this->uploadDir;
    }

    /**
     * @return array<string, mixed>
     */
    public function diagnostics(): array
    {
        $dir = rtrim($this->uploadDir, '/\\');
        $exists = is_dir($dir);
        $writable = $exists && is_writable($dir);
        $resolved = $exists ? realpath($dir) : false;

        $phpUser = 'inconnu';
        if (function_exists('posix_geteuid') && function_exists('posix_getpwuid')) {
            $account = posix_getpwuid(posix_geteuid());
            if (is_array($account) && !empty($account['name'])) {
                $phpUser = (string) $account['name'];
            }
        } elseif (function_exists('get_current_user')) {
            $current = get_current_user();
            if (is_string($current) && $current !== '') {
                $phpUser = $current;
            }
        }

        $recentFiles = [];
        $fileCount = 0;
        if ($exists && is_readable($dir)) {
            $entries = scandir($dir);
            if (is_array($entries)) {
                foreach ($entries as $entry) {
                    if ($entry === '.' || $entry === '..') {
                        continue;
                    }
                    $fileCount++;
                    if (count($recentFiles) < 15) {
                        $recentFiles[] = $entry;
                    }
                }
            }
        }

        return [
            'uploadDir' => $dir,
            'uploadDirExists' => $exists,
            'uploadDirWritable' => $writable,
            'realpath' => is_string($resolved) ? $resolved : null,
            'phpUser' => $phpUser,
            'hostname' => gethostname() ?: null,
            'uploadMaxFilesize' => ini_get('upload_max_filesize'),
            'postMaxSize' => ini_get('post_max_size'),
            'fileCount' => $fileCount,
            'recentFiles' => $recentFiles,
        ];
    }

    private function sanitizeFilename(string $original): string
    {
        $basename = basename(str_replace('\\', '/', $original));
        $basename = preg_replace('/[^\w.\- ]+/u', '_', $basename) ?? '';
        $basename = trim(preg_replace('/\s+/u', ' ', $basename) ?? '', ' .');

        if ($basename === '' || $basename === '.' || $basename === '..') {
            throw new HttpException('Nom de fichier invalide', 422);
        }

        $extension = strtolower(pathinfo($basename, PATHINFO_EXTENSION));
        if (!in_array($extension, self::ALLOWED_EXTENSIONS, true)) {
            throw new HttpException('Extension non autorisee', 422);
        }

        return $basename;
    }

    private function uploadErrorMessage(int $error): string
    {
        return match ($error) {
            UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Fichier trop volumineux pour le serveur',
            UPLOAD_ERR_PARTIAL => 'Upload incomplet, reessayez',
            UPLOAD_ERR_NO_FILE => 'Aucun fichier recu',
            UPLOAD_ERR_NO_TMP_DIR => 'Repertoire temporaire manquant sur le serveur',
            UPLOAD_ERR_CANT_WRITE => 'Ecriture disque impossible',
            UPLOAD_ERR_EXTENSION => 'Upload bloque par une extension PHP',
            default => 'Erreur lors de l upload',
        };
    }
}
