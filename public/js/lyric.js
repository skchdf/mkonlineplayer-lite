/**************************************************
 * MKOnlinePlayer v2.31
 * 歌词解析及滚动模块
 * 编写：mengkun(http://mkblog.cn)
 * 时间：2017-9-13
 *
 * 2026: 支持显示歌词翻译（tlyric）
 *************************************************/
 
var lyricArea = $("#lyric");    // 歌词显示容器

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
    
    rem.lyric = parseLyric(rem.lyricRaw);    // 解析获取到的歌词
    
    if(rem.lyric === '') {
        lyricTip('没有歌词');
        return false;
    }
    
    // 把翻译按原文行对齐（上游 tlyric 的时间轴有时会整体错位一行）
    var pairs = pairLyricLines(rem.lyricRaw, rem.lyricTransRaw);
    var transMap = {};
    for(var p = 0; p < pairs.length; p++) {
        if(pairs[p].trans) transMap[Math.floor(pairs[p].sec)] = pairs[p].trans;
    }
    
    lyricArea.html('');     // 清空歌词区域的内容
    lyricArea.scrollTop(0);    // 滚动到顶部
    
    rem.lastLyric = -1;
    
    // 显示全部歌词
    var i = 0;
    for(var k in rem.lyric){
        var txt = rem.lyric[k];
        if(!txt) txt = "&nbsp;";
        var html = '<span class="lrc-text">' + txt + '</span>';
        // 同一时间点有翻译则一起显示
        if(transMap[k] !== undefined && transMap[k] !== '') {
            html += '<span class="lrc-trans">' + transMap[k] + '</span>';
        }
        var li = $("<li data-no='"+i+"' class='lrc-item'>"+html+"</li>");
        lyricArea.append(li);
        i++;
    }
}

// 强制刷新当前时间点的歌词
// 参数：当前播放时间（单位：秒）
function refreshLyric(time) {
    if(rem.lyric === '') return false;
    
    time = parseInt(time);  // 时间取整
    var i = 0;
    for(var k in rem.lyric){
        if(k >= time) break;
        i = k;      // 记录上一句的
    }
    
    scrollLyric(i);
}

// 滚动歌词到指定句
// 参数：当前播放时间（单位：秒）
function scrollLyric(time) {
    if(rem.lyric === '') return false;
    
    time = parseInt(time);  // 时间取整
    
    if(rem.lyric === undefined || rem.lyric[time] === undefined) return false;  // 当前时间点没有歌词
    
    if(rem.lastLyric == time) return true;  // 歌词没发生改变
    
    var i = 0;  // 获取当前歌词是在第几行
    for(var k in rem.lyric){
        if(k == time) break;
        i ++;
    }
    rem.lastLyric = time;  // 记录方便下次使用
    $(".lplaying").removeClass("lplaying");     // 移除其余句子的正在播放样式
    var current = $(".lrc-item[data-no='" + i + "']");
    current.addClass("lplaying");    // 加上正在播放样式
    
    // 按当前歌词项的实际位置滚动（带翻译的歌词项高度不一样）
    var scroll = current.position().top + current.outerHeight() / 2 - lyricArea.parent().height() / 2;
    lyricArea.stop().animate({scrollTop: scroll}, 1000);  // 平滑滚动到当前歌词位置(更改这个数值可以改变歌词滚动速度，单位：毫秒)
    
}

// 解码歌词中的 URL 编码，解码失败时保留原文
function safeDecode(str) {
    try {
        return decodeURIComponent(str);
    } catch(e) {
        return str;
    }
}

// 解析歌词
// 这一函数来自 https://github.com/TivonJJ/html5-music-player
// 参数：原始歌词文件
function parseLyric(lrc) {
    if(!lrc) return '';
    var lyrics = lrc.split("\n");
    var lrcObj = {};
    for(var i=0;i<lyrics.length;i++){
        var lyric = safeDecode(lyrics[i]);
        var timeReg = /\[\d*:\d*((\.|\:)\d*)*\]/g;
        var timeRegExpArr = lyric.match(timeReg);
        if(!timeRegExpArr)continue;
        var clause = lyric.replace(timeReg,'');
        for(var k = 0,h = timeRegExpArr.length;k < h;k++) {
            var t = timeRegExpArr[k];
            var min = Number(String(t.match(/\[\d*/i)).slice(1)),
                sec = Number(String(t.match(/\:\d*/i)).slice(1));
            var time = min * 60 + sec;
            lrcObj[time] = clause;
        }
    }
    return lrcObj;
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
        if(skipMeta && /^(作词|作曲|编曲|制作人|混音|母带|录音|出品|监制|词|曲)\s*[:：]/.test(text)) continue;
        
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
