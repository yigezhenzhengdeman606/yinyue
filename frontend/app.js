const $ = (id) => document.getElementById(id);
const audio = $("audio");
const tracks = [];
const colors = ["#7b8e74", "#aa7a69", "#7b8d9c", "#a89a69", "#95809a", "#698d87"];

let pet = { name: "小栗", type: "cat" };
let current = null;
let requestVersion = 0;
let activeAnimation = null;
let delivering = false;
let generating = false;
let toastTimer;

try {
    const saved = JSON.parse(localStorage.getItem("luma-pet"));
    if (saved && typeof saved.name === "string" &&
        ["cat", "dog"].includes(saved.type)) {
        pet = { name: saved.name.slice(0, 12) || "小栗", type: saved.type };
    }
} catch {}

audio.volume = .8;

function petIcon() {
    return pet.type === "dog" ? "🐕" : "🐈";
}

function updatePet() {
    $("homePet").textContent = petIcon();
    $("courierPet").textContent = petIcon();
    $("dockPet").textContent = petIcon();
    $("petNameLabel").textContent = pet.name;
    $("welcome").textContent = `选一本音乐，让${pet.name}送到你身边。`;
}
updatePet();

function notify(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => $("toast").hidden = true, 5000);
}

async function api(path, method = "GET", body) {
    const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: {
            "Content-Type": "application/json",
            "X-Luma-Client": "1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error("服务器返回了无效响应。");
    }
    if (!response.ok) {
        throw new Error(
            typeof result.detail === "string" ? result.detail : "请求失败，请检查输入。"
        );
    }
    return result;
}

function booksPerRow() {
    return window.innerWidth <= 720 ? 5 : 9;
}

function renderShelf() {
    const query = $("search").value.trim().toLowerCase();
    const visible = tracks.filter(t => t.title.toLowerCase().includes(query));
    const container = $("shelves");
    container.replaceChildren();

    const size = booksPerRow();
    // 空书架也保留两层，形成完整书屋。
    const rowCount = Math.max(2, Math.ceil(visible.length / size));

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const row = document.createElement("div");
        row.className = "shelf-row";

        for (const track of visible.slice(rowIndex * size, (rowIndex + 1) * size)) {
            const book = document.createElement("button");
            book.className = `book${track === current ? " active" : ""}`;
            book.dataset.id = track.id;
            book.style.setProperty("--book-color", track.color);
            book.style.setProperty("--height", `${track.height}px`);
            book.setAttribute("aria-label", `播放 ${track.title}`);

            const title = document.createElement("span");
            title.className = "book-title";
            title.textContent = track.title;
            book.append(title);
            book.addEventListener("click", () => deliver(track, book));
            row.append(book);
        }
        container.append(row);
    }

    $("empty").hidden = visible.length > 0;
    $("empty").textContent = tracks.length
        ? "没有找到这本音乐，换一个关键词试试。"
        : "书架正在等待第一段旋律。导入音乐，给书屋添一本新书。";
    $("bookCount").textContent = `${tracks.length} BOOKS`;
}

$("files").addEventListener("change", event => {
    let count = 0;
    for (const file of event.target.files) {
        if (!file.type.startsWith("audio/") &&
            !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name)) continue;
        const index = tracks.length;
        tracks.push({
            id: crypto.randomUUID(),
            title: file.name.replace(/\.[^.]+$/, ""),
            url: URL.createObjectURL(file),
            color: colors[index % colors.length],
            height: 125 + (index * 17 % 40),
            context: "",
            animation: "auto",
            art: null,
        });
        count++;
    }
    event.target.value = "";
    renderShelf();
    notify(count ? `书屋新增了 ${count} 本音乐。` : "请选择有效音频文件。");
});

$("search").addEventListener("input", renderShelf);
let resizeTimer;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        // 屏幕旋转时取消旧坐标动画，避免落点错位。
        if (delivering) cancelDelivery();
        renderShelf();
    }, 150);
});

function point(element, offsetX = .5, offsetY = .5) {
    const rect = element.getBoundingClientRect();
    return {
        x: rect.left + rect.width * offsetX - 40,
        y: rect.top + rect.height * offsetY - 45,
    };
}

async function movePet(from, to, duration, jump = false) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const middle = {
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2 - (jump ? 80 : 10),
    };

    const animation = $("courier").animate([
        { transform: `translate(${from.x}px, ${from.y}px)` },
        {
            transform: `translate(${middle.x}px, ${middle.y}px)`,
            offset: .5,
        },
        { transform: `translate(${to.x}px, ${to.y}px)` },
    ], {
        duration: reduced ? 1 : duration,
        easing: "ease-in-out",
        fill: "forwards",
    });

    activeAnimation = animation;
    await animation.finished;
    // 下一段动画显式提供起点，因此可以清除上一段效果。
    animation.cancel();
    if (activeAnimation === animation) activeAnimation = null;
}

function cancelDelivery() {
    requestVersion++;
    activeAnimation?.cancel();
    activeAnimation = null;
    delivering = false;
    $("courier").hidden = true;
    $("carriedBook").hidden = true;
    $("petHome").hidden = false;
    document.querySelectorAll(".in-transit").forEach(el =>
        el.classList.remove("in-transit")
    );
    if (!current) $("playerStatus").textContent = "点击书架上的书籍开始";
}

async function fadeOut(version) {
    const initial = audio.volume;
    for (let step = 1; step <= 6; step++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (version !== requestVersion) return;
        audio.volume = initial * (1 - step / 6);
    }
    if (version === requestVersion) audio.pause();
}

async function deliver(track, sourceBook) {
    cancelDelivery();
    const version = requestVersion;
    delivering = true;

    $("dockPet").hidden = true;
    $("petHome").hidden = true;
    $("courier").hidden = false;
    $("carriedBook").hidden = true;
    $("carriedBook").style.background = track.color;
    $("playerStatus").textContent = `${pet.name}正在帮你取书…`;

    // 与宠物取书同时淡出当前音乐。
    const fading = fadeOut(version);
    const start = point($("petHome"));
    const source = sourceBook?.isConnected
        ? point(sourceBook)
        : { x: window.innerWidth / 2 - 40, y: 160 };

    try {
        await movePet(start, source, 650, true);
        if (version !== requestVersion) return;

        sourceBook?.classList.add("in-transit");
        $("carriedBook").hidden = false;
        $("playerStatus").textContent = `${pet.name}把《${track.title}》叼来了`;

        // 此时重新读取进度条坐标，以适应页面滚动。
        const destination = point($("progressDock"), .08, .5);
        await movePet(source, destination, 950, true);
        await fading;
        if (version !== requestVersion) return;

        $("courier").hidden = true;
        $("carriedBook").hidden = true;
        $("dockPet").hidden = false;
        $("petHome").hidden = true;

        current = track;
        audio.src = track.url;
        audio.volume = Number($("volume").value);
        $("nowTitle").textContent = track.title;
        $("playerBook").style.backgroundColor = track.color;
        $("playerStatus").textContent = `${pet.name}陪你听歌`;
        renderShelf();

        try {
            await audio.play();
            if (version !== requestVersion) return;
        } catch {
            if (version === requestVersion) {
                notify("音乐已送达，请点击播放按钮开始聆听。");
            }
        }
    } catch (error) {
        // 连续点书会取消旧动画，属于正常交互。
        if (error.name !== "AbortError") notify("动画暂时失败，请重新选择音乐。");
    } finally {
        if (version === requestVersion) {
            delivering = false;
            $("courier").hidden = true;
            sourceBook?.classList.remove("in-transit");
            if (!current) $("petHome").hidden = false;
        }
    }
}

$("play").addEventListener("click", async () => {
    if (delivering) return notify(`${pet.name}正在送书，请稍等。`);
    if (!current) {
        if (!tracks.length) return notify("请先收藏一些本地音乐。");
        return deliver(tracks[0], document.querySelector(".book"));
    }
    if (!audio.paused) return audio.pause();
    try {
        await audio.play();
    } catch {
        notify("无法播放，请检查音频文件格式。");
    }
});

function nextTrack(direction) {
    if (!tracks.length) return notify("请先导入音乐。");
    const index = current ? tracks.indexOf(current) : (direction > 0 ? -1 : 0);
    const track = tracks[(index + direction + tracks.length) % tracks.length];
    const book = [...document.querySelectorAll(".book")]
        .find(el => el.dataset.id === track.id);
    deliver(track, book);
}

$("previous").addEventListener("click", () => nextTrack(-1));
$("next").addEventListener("click", () => nextTrack(1));
audio.addEventListener("ended", () => nextTrack(1));
audio.addEventListener("play", () => $("play").textContent = "Ⅱ");
audio.addEventListener("pause", () => $("play").textContent = "▶");
audio.addEventListener("error", () => notify("音频无法解码，请尝试 MP3 或 WAV。"));

function clock(value) {
    if (!Number.isFinite(value)) return "0:00";
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

audio.addEventListener("timeupdate", () => {
    $("elapsed").textContent = clock(audio.currentTime);
    $("duration").textContent = clock(audio.duration);
    const progress = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.currentTime / audio.duration * 100 : 0;
    $("seek").value = progress;
    // 宠物跟随进度条缓慢移动。
    $("dockPet").style.left = `calc(${progress}% - ${progress * .28}px)`;
});

$("seek").addEventListener("input", () => {
    if (Number.isFinite(audio.duration)) {
        audio.currentTime = Number($("seek").value) / 100 * audio.duration;
    }
});
$("volume").addEventListener("input", () => {
    audio.volume = Number($("volume").value);
});

$("petSettings").addEventListener("click", () => {
    $("petName").value = pet.name;
    $("petType").value = pet.type;
    $("petDialog").showModal();
});
$("petForm").addEventListener("submit", event => {
    event.preventDefault();
    const name = $("petName").value.trim();
    if (!name) return notify("请给宠物起个名字。");
    pet = { name, type: $("petType").value };
    try {
        localStorage.setItem("luma-pet", JSON.stringify(pet));
    } catch {
        notify("浏览器无法保存设置，本次仍可使用。");
    }
    updatePet();
    $("petDialog").close();
});
$("petHome").addEventListener("click", () => {
    notify(`${pet.name}蹭了蹭你：今天想听哪一本？`);
});

$("aiSettings").addEventListener("click", () => $("settingsDialog").showModal());
$("settingsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
        const result = await api("/api/settings", "POST", {
            api_key: $("apiKey").value,
            text_model: $("textModel").value,
            image_model: $("imageModel").value,
        });
        notify(result.message);
        $("settingsDialog").close();
    } catch (error) {
        notify(error.message);
    } finally {
        $("apiKey").value = "";
        button.disabled = false;
    }
});
$("clearKey").addEventListener("click", async () => {
    try {
        const result = await api("/api/settings", "DELETE");
        notify(result.message);
    } catch (error) {
        notify(error.message);
    }
});
$("settingsDialog").addEventListener("close", () => $("apiKey").value = "");

function renderArt(track) {
    $("artTitle").textContent = track.title;
    $("context").value = track.context;
    $("animation").value = track.animation;
    $("summary").textContent = track.art?.summary ||
        "填写歌词或描述，绘制这本音乐里的世界。";
    $("artImage").hidden = !track.art;
    if (track.art) $("artImage").src = track.art.image;
    else $("artImage").removeAttribute("src");
    applyArtAnimation(track);
}

function applyArtAnimation(track) {
    const mode = track.animation === "auto"
        ? track.art?.animation || "aurora" : track.animation;
    $("artVisual").className = `art-visual ${mode}`;
}

let artTrack = null;
$("openArt").addEventListener("click", () => {
    if (!current) return notify("请先让宠物送来一本音乐。");
    artTrack = current;
    renderArt(artTrack);
    $("artDialog").showModal();
});
$("context").addEventListener("input", () => {
    if (artTrack) artTrack.context = $("context").value;
});
$("animation").addEventListener("change", () => {
    if (!artTrack) return;
    artTrack.animation = $("animation").value;
    applyArtAnimation(artTrack);
});
$("generateArt").addEventListener("click", async () => {
    if (!artTrack || generating) return;
    const track = artTrack;
    const context = track.context.trim();
    if (!context) return notify("请填写歌词或歌曲描述。");
    generating = true;
    $("generateArt").disabled = true;
    $("generateArt").textContent = "正在绘制书中的世界…";
    try {
        const result = await api("/api/art", "POST", {
            title: track.title,
            context,
        });
        if (track.context.trim() !== context) {
            return notify("描述已修改，请重新生成。");
        }
        track.art = result;
        if (artTrack === track) renderArt(track);
        notify("歌曲意境已生成。");
    } catch (error) {
        notify(error.message);
    } finally {
        generating = false;
        $("generateArt").disabled = false;
        $("generateArt").textContent = "生成意境";
    }
});

$("composeForm").addEventListener("submit", async event => {
    event.preventDefault();
    const title = $("songTitle").value.trim();
    const lyrics = $("lyrics").value.trim();
    if (!title || !lyrics) return notify("请填写标题和歌词。");
    try {
        await api("/api/compose", "POST", { title, lyrics });
    } catch (error) {
        notify(error.message);
    }
});
$("downloadLyrics").addEventListener("click", () => {
    const title = $("songTitle").value.trim();
    const lyrics = $("lyrics").value.trim();
    if (!title || !lyrics) return notify("请填写标题和歌词。");
    const url = URL.createObjectURL(
        new Blob([`${title}\n\n${lyrics}`], { type: "text/plain;charset=utf-8" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[\\/:*?"<>|]/g, "_")}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => $(button.dataset.close).close());
});
window.addEventListener("beforeunload", () => {
    tracks.forEach(track => URL.revokeObjectURL(track.url));
});

renderShelf();