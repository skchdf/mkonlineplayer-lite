/**************************************************
 * MKOnlinePlayer v2.31
 * 歌词解析及滚动模块
 * 编写：mengkun(http://mkblog.cn)
 * 时间：2017-9-13
 *
 * 2026: 支持显示歌词翻译（tlyric）
 *************************************************/
 
var lyricArea = $("#lyric");    // 歌词显示容器

// HTML 转义：歌名/歌手/歌词都来自接口，直接拼进 innerHTML 会被当成标签执行（XSS）
function mkHtmlEscape(str) {
    return String(str === undefined || str === null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 在歌词区显示提示语（如歌词加载中、无歌词等）
function lyricTip(str) {
    lyricArea.html("<li class='lyric-tip'>"+str+"</li>");     // 显示内容
}

// 歌曲加载完后的回调函数
// 参数：歌词源文件、翻译歌词源文件、歌词ID
function lyricCallback(str, tlyric, id) {
    var music = musicList[rem.playlist] && musicList[rem.playlist].item[rem.playid];
    if(!music) return false;
    if(id !== undefined && id !== null && id != music.lyric_id) return false;  // 返回的歌词不是当前这首歌的，跳过
    
    // 缓存原始歌词，供“下载歌词文件”使用
    rem.lyricRaw = str || '';
    rem.lyricTransRaw = tlyric || '';
    
    var lines = parseDisplayLines(rem.lyricRaw);    // 解析获取到的歌词（保留毫秒）
    rem.lyric = lines;
    
    if(!lines.length) {
        lyricTip('没有歌词');
        rem.lastLyric = -1;
        return false;
    }
    
    attachTranslation(lines, rem.lyricTransRaw);    // 把翻译对到原文行上
    
    lyricArea.html('');     // 清空歌词区域的内容
    rem.lastLyric = -1;
    
    // 显示全部歌词
    var html = [];
    for(var i = 0; i < lines.length; i++) {
        var txt = mkHtmlEscape(lines[i].text);
        if(!txt) txt = "&nbsp;";
        var item = '<span class="lrc-text">' + txt + '</span>';
        // 同一时间点有翻译则一起显示
        if(lines[i].trans) {
            item += '<span class="lrc-trans">' + mkHtmlEscape(lines[i].trans) + '</span>';
        }
        html.push("<li data-no='" + i + "' class='lrc-item'>" + item + "</li>");
    }
    lyricArea.html(html.join(''));
    lyricArea.scrollTop(0);    // 滚动到顶部
    return true;
}

// 找出当前时间对应的歌词行号（最后一句 sec <= time）
// 参数：当前播放时间（单位：秒，可带小数）
function findLyricIndex(time) {
    var lines = rem.lyric;
    if(!lines || !lines.length) return -1;
    var t = Number(time) || 0;
    var lo = 0, hi = lines.length - 1, ans = -1;
    while(lo <= hi) {
        var mid = (lo + hi) >> 1;
        if(lines[mid].sec <= t + 0.001) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

// 强制刷新当前时间点的歌词
// 参数：当前播放时间（单位：秒）
function refreshLyric(time) {
    return scrollLyric(time);
}

// 滚动歌词到指定句
// 参数：当前播放时间（单位：秒）
function scrollLyric(time) {
    var lines = rem.lyric;
    if(!lines || !lines.length) return false;

    var idx = findLyricIndex(time);
    if(idx < 0) return false;               // 还没到第一句
    if(rem.lastLyric === idx) return true;  // 歌词没发生改变

    var current = $(".lrc-item[data-no='" + idx + "']");
    if(!current.length) return false;

    rem.lastLyric = idx;    // 记录方便下次使用
    $(".lplaying").removeClass("lplaying");     // 移除其余句子的正在播放样式
    current.addClass("lplaying");    // 加上正在播放样式

    // 目标位置必须用“内容坐标”算：
    // position() 是相对 offsetParent 的，会被 scrollTop 带偏，
    // 每滚一次目标就少 scrollTop，导致来回乱跳。
    var target = current.offset().top - lyricArea.offset().top + lyricArea.scrollTop()
               + current.outerHeight() / 2 - lyricArea.height() / 2;
    var max = lyricArea[0].scrollHeight - lyricArea[0].clientHeight;
    if(target > max) target = max;
    if(target < 0) target = 0;
    lyricArea.stop().animate({scrollTop: target}, 600);  // 平滑滚动到当前歌词位置(更改这个数值可以改变歌词滚动速度，单位：毫秒)
    return true;
}

// 解码歌词中的 URL 编码，解码失败时保留原文
function safeDecode(str) {
    try {
        return decodeURIComponent(str);
    } catch(e) {
        return str;
    }
}

// 这一行是否属于作词/作曲之类的元信息（不是真正要唱的歌词）
function isLyricMeta(text) {
    return /^(作词|作曲|编曲|制作人|混音|母带|录音|出品|监制|词|曲)\s*[:：]/.test(text);
}

// 解析出用于显示的歌词行
// 返回：[{ sec, text }]，按时间升序；同一行带多个时间标签会展开成多条
function parseDisplayLines(lrc) {
    var out = [];
    var lines = (lrc || '').split(/\r?\n/);
    for(var i = 0; i < lines.length; i++) {
        var line = safeDecode(lines[i]);
        var times = lrcLineTimes(line);
        if(!times.length) continue;
        var text = line.replace(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g, '').trim();
        for(var j = 0; j < times.length; j++) {
            out.push({ sec: times[j].sec, text: text, trans: null });
        }
    }
    out.sort(function(a, b){ return a.sec - b.sec; });
    return out;
}

// 把翻译行对到显示的原文行上
// 行数一致时按顺序配对（上游 tlyric 的时间轴有时会整体错位一行）；
// 否则按时间戳配对，允许 150ms 误差。
function attachTranslation(lines, tlyric) {
    var trans = parseLyricLines(tlyric, true);
    if(!trans.length) return;

    var targets = [];
    for(var i = 0; i < lines.length; i++) {
        if(lines[i].text && !isLyricMeta(lines[i].text)) targets.push(lines[i]);
    }

    if(targets.length === trans.length) {
        for(var n = 0; n < targets.length; n++) targets[n].trans = trans[n].text;
        return;
    }

    var byMs = {}, keys = [];
    for(var t = 0; t < trans.length; t++) {
        for(var j = 0; j < trans[t].times.length; j++) {
            var k = Math.round(trans[t].times[j].sec * 1000);
            if(byMs[k] === undefined) { byMs[k] = trans[t].text; keys.push(k); }
        }
    }
    keys.sort(function(a, b){ return a - b; });

    function nearMs(sec) {
        var target = Math.round(sec * 1000), best = null, bestDiff = 150;
        for(var i = 0; i < keys.length; i++) {
            var diff = Math.abs(keys[i] - target);
            if(diff < bestDiff) { bestDiff = diff; best = keys[i]; }
            else if(keys[i] > target + 150) break;
        }
        return best === null ? null : byMs[best];
    }

    for(var n = 0; n < lines.length; n++) {
        if(!lines[n].text) continue;
        var key = Math.round(lines[n].sec * 1000);
        lines[n].trans = byMs[key] !== undefined ? byMs[key] : nearMs(lines[n].sec);
    }
}

// 提取一行歌词中的所有时间标签及其对应秒数
function lrcLineTimes(line) {
    var reg = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    var times = [], m;
    while((m = reg.exec(line)) !== null) {
        var ms = m[3] ? Number('0.' + m[3]) * 1000 : 0;
        times.push({
            raw: m[0],
            sec: Number(m[1]) * 60 + Number(m[2]) + ms / 1000
        });
    }
    return times;
}

// 解析出歌词中的有效行（跳过空行和作词/作曲等元信息）
// 返回：[{ rawIndex, times, rawTags, sec, text }]
function parseLyricLines(lrc, skipMeta) {
    var result = [];
    var lines = (lrc || '').split(/\r?\n/);
    for(var i = 0; i < lines.length; i++) {
        var line = safeDecode(lines[i]);
        var times = lrcLineTimes(line);
        if(!times.length) continue;
        var text = line.replace(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g, '').trim();
        if(!text) continue;
        if(skipMeta && isLyricMeta(text)) continue;
        
        var rawTags = '';
        for(var j = 0; j < times.length; j++) rawTags += times[j].raw;
        result.push({
            rawIndex: i,
            times: times,
            rawTags: rawTags,
            sec: times[0].sec,
            text: text
        });
    }
    return result;
}

// 把翻译歌词和原文歌词逐行配对
// 返回原文有效行数组，每项多一个 trans 字段（没有翻译则为 null）
function pairLyricLines(lyric, tlyric) {
    var main = parseLyricLines(lyric, true);
    var trans = parseLyricLines(tlyric, true);
    if(!trans.length) return main;
    
    // 行数一致时直接按顺序配对：
    // 网易云有些歌曲的 tlyric 时间轴会整体错位一行，按时间戳会配错，按顺序则能修正
    var byOrder = (main.length === trans.length);
    
    var byMs = {}, keys = [];
    for(var i = 0; i < trans.length; i++) {
        for(var j = 0; j < trans[i].times.length; j++) {
            var msKey = Math.round(trans[i].times[j].sec * 1000);
            byMs[msKey] = trans[i].text;
            keys.push(msKey);
        }
    }
    keys.sort(function(a, b){ return a - b; });
    
    // 时间戳相差很小（150ms 内）也算同一句
    function findByTime(sec) {
        var target = sec * 1000, best = null, bestDiff = 150;
        for(var i = 0; i < keys.length; i++) {
            var diff = Math.abs(keys[i] - target);
            if(diff < bestDiff) {
                bestDiff = diff;
                best = keys[i];
            } else if(keys[i] > target + 150) {
                break;
            }
        }
        return best === null ? null : byMs[best];
    }
    
    for(var n = 0; n < main.length; n++) {
        var text = null;
        if(byOrder) {
            text = trans[n].text;
        } else {
            for(var k = 0; k < main[n].times.length; k++) {
                var key = Math.round(main[n].times[k].sec * 1000);
                if(byMs[key] !== undefined) {
                    text = byMs[key];
                    break;
                }
            }
            if(text === null) text = findByTime(main[n].sec);
        }
        main[n].trans = text;
    }
    return main;
}
