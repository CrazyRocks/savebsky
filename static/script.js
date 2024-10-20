$(document).ready(function() {
    // Language switcher functionality
    const $languageButton = $('#languageButton');
    const $languageMenu = $('#languageMenu');
    const $currentLanguage = $('#currentLanguage');

    $languageButton.on('click', function(e) {
        e.preventDefault();
        $languageMenu.toggleClass('hidden show');
    });

    $(document).on('click', function(e) {
        if (!$(e.target).closest($languageButton).length && !$(e.target).closest($languageMenu).length) {
            $languageMenu.removeClass('show').addClass('hidden');
        }
    });

    const currentLang = window.location.pathname.split('/')[1] || 'en';
    const $currentLangLink = $languageMenu.find(`a[href="/${currentLang}/"]`).length ? 
                             $languageMenu.find(`a[href="/${currentLang}/"]`) : 
                             $languageMenu.find('a[href="/"]');
    
    if ($currentLangLink.length) {
        $currentLangLink.addClass('font-bold bg-gray-200');
        $currentLanguage.text($currentLangLink.text());
    }

    $languageMenu.find('a').on('click', function(e) {
        e.preventDefault();
        window.location.href = $(this).attr('href');
    });

    // Bluesky video processing functionality
    async function processBlueskyVideo(postUrl, format, statusCallback, progressCallback) {
        try {
            statusCallback('Extracting post info...');
            const { handle, rkey } = extractPostInfo(postUrl);
            
            statusCallback('Resolving DID...');
            const did = await getDidFromHandle(handle);
            
            statusCallback('Fetching post details...');
            const videoInfo = await getVideoInfoFromPost(did, rkey);
            
            if (!videoInfo) {
                throw new Error('No video found in the post');
            }
            
            statusCallback('Downloading video segments...');
            const videoBlob = await downloadAndProcessVideo(videoInfo.playlist, format, progressCallback);
            
            return {
                videoBlob,
                thumbnailUrl: videoInfo.thumbnail,
                handle: videoInfo.handle,
                createdAt: videoInfo.createdAt
            };
        } catch (error) {
            console.error('Error:', error);
            throw error;
        }
    }

    function extractPostInfo(url) {
        const match = url.match(/^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([^/]+)$/);
        if (match) {
            return {
                handle: match[1],
                rkey: match[2],
            };
        }
        throw new Error('Invalid Bluesky post URL');
    }

    async function getDidFromHandle(handle) {
        const response = await $.ajax({
            url: `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`,
            method: 'GET'
        });
        return response.did;
    }

    async function getVideoInfoFromPost(did, rkey) {
        const postUri = `at://${did}/app.bsky.feed.post/${rkey}`;
        const encodedUri = encodeURIComponent(postUri);
        const response = await $.ajax({
            url: `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodedUri}&depth=0`,
            method: 'GET'
        });

        const threadPost = response.thread.post;
        const embed = threadPost.embed;

        const createdAt = threadPost.record?.createdAt || threadPost.indexedAt || new Date().toISOString();
        const posterHandle = threadPost.author.handle;

        if (embed && embed.$type === 'app.bsky.embed.video#view') {
            return {
                playlist: embed.playlist,
                thumbnail: embed.thumbnail,
                createdAt,
                handle: posterHandle,
            };
        }

        return null;
    }

    async function downloadAndProcessVideo(masterPlaylistUrl, format, progressCallback) {
        const masterPlaylistResponse = await $.ajax({
            url: masterPlaylistUrl,
            method: 'GET'
        });
        
        const videoPlaylistUrl = parseHighestQualityVideoUrl(masterPlaylistResponse, masterPlaylistUrl);
        const videoPlaylistResponse = await $.ajax({
            url: videoPlaylistUrl,
            method: 'GET'
        });
        
        const segmentUrls = parseSegmentUrls(videoPlaylistResponse, videoPlaylistUrl);
        const chunks = await downloadSegments(segmentUrls, progressCallback);
        
        const mimeType = format === 'mp4' ? 'video/mp4' : 'video/MP2T';
        return new Blob(chunks, { type: mimeType });
    }

    function parseHighestQualityVideoUrl(masterPlaylist, baseUrl) {
        const lines = masterPlaylist.split('\n');
        let highestBandwidth = 0;
        let highestQualityUrl = '';

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                if (bandwidthMatch) {
                    const bandwidth = parseInt(bandwidthMatch[1]);
                    if (bandwidth > highestBandwidth) {
                        highestBandwidth = bandwidth;
                        highestQualityUrl = lines[i + 1];
                    }
                }
            }
        }

        return new URL(highestQualityUrl, baseUrl).toString();
    }

    function parseSegmentUrls(videoPlaylist, baseUrl) {
        return videoPlaylist.split('\n')
            .filter(line => !line.startsWith('#') && line.trim() !== '')
            .map(segment => new URL(segment, baseUrl).toString());
    }

    async function downloadSegments(segmentUrls, progressCallback) {
        const chunks = [];
        const totalSegments = segmentUrls.length;

        for (let i = 0; i < totalSegments; i++) {
            const url = segmentUrls[i];
            const response = await $.ajax({
                url: url,
                method: 'GET',
                xhr: function() {
                    const xhr = new window.XMLHttpRequest();
                    xhr.responseType = 'arraybuffer';
                    return xhr;
                }
            });
            chunks.push(response);

            progressCallback((i + 1) / totalSegments);
        }

        return chunks;
    }

    function sanitizeFilename(name) {
        return name.replace(/[^a-z0-9_\-]/gi, '_');
    }

    function formatDateForFilename(date) {
        const pad = (n) => n.toString().padStart(2, '0');
        const year = date.getFullYear();
        const month = pad(date.getMonth() + 1);
        const day = pad(date.getDate());
        const hours = pad(date.getHours());
        const minutes = pad(date.getMinutes());
        const seconds = pad(date.getSeconds());
        return `${year}${month}${day}_${hours}${minutes}${seconds}`;
    }

    $('#downloadForm').on('submit', async function(e) {
        e.preventDefault();
        const postUrl = $('#postUrl').val();
        const format = $('#formatSelect').val();
        const $status = $('#status');
        const $downloadLink = $('#downloadLink');
        const $progressBar = $('#progressBar');
        const $progressBarInner = $progressBar.find('div');
        const $thumbnail = $('#thumbnail');

        console.log(format);

        $status.text('Processing...').css('color', '');
        $downloadLink.hide();
        $progressBar.hide();
        $thumbnail.hide();
        $progressBarInner.width('0%');

        try {
            const result = await processBlueskyVideo(
                postUrl, 
                format,
                (status) => {
                    $status.text(status);
                },
                (progress) => {
                    $progressBar.show();
                    $progressBarInner.width(`${progress * 100}%`);
                }
            );

            const { videoBlob, thumbnailUrl, handle, createdAt } = result;

            $thumbnail.attr('src', thumbnailUrl).show();

            const url = URL.createObjectURL(videoBlob);

            const sanitizedHandle = sanitizeFilename(handle || 'bluesky');
            const date = new Date(createdAt || Date.now());
            const formattedDate = formatDateForFilename(date);
            const fileExtension = format === 'mp4' ? 'mp4' : 'ts';
            const filename = `${sanitizedHandle}_${formattedDate}.${fileExtension}`;

            $downloadLink.attr({
                'href': url,
                'download': filename
            }).css('display', 'block');
            
            $status.text('Video ready for download!');
        } catch (error) {
            console.error('Error:', error);
            $status.text(error.message || 'An error occurred. Please try again.').css('color', 'red');
        }
    });

    // Add paste functionality
    $('#pasteButton').on('click', function() {
        navigator.clipboard.readText()
            .then(text => {
                $('#postUrl').val(text);
            })
            .catch(err => {
                console.error('Failed to read clipboard contents: ', err);
                alert('Unable to access clipboard. Please ensure you have granted the website permission to access the clipboard.');
            });
    });
});
