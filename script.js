document.getElementById("start-btn").addEventListener("click", function () {
  const subtitleFile = document.getElementById("subtitle-file").files[0];

  if (subtitleFile) {
    const subtitleDiv = document.getElementById("subtitle");

    // 解析并加载字幕文件
    const reader = new FileReader();
    reader.onload = function (e) {
      const subtitleText = e.target.result;
      const subtitles = parseSRT(subtitleText);

      // 开始显示字幕
      subtitleDiv.style.display = "block";

      // 定时更新字幕，根据系统时间显示对应的字幕
      setInterval(() => {
        const currentTime = new Date().getTime() / 1000; // 当前时间的秒数
        const subtitle = getSubtitleForTime(subtitles, currentTime);
        subtitleDiv.textContent = subtitle ? subtitle.text : "";
      }, 500); // 每500ms检查一次
    };
    reader.readAsText(subtitleFile);
  } else {
    alert("Please upload a subtitle file.");
  }
});

function parseSRT(data) {
  // 简单 SRT 解析，将 SRT 转化为对象数组
  const subtitles = [];
  const srtBlocks = data.split("\n\n");
  srtBlocks.forEach((block) => {
    const lines = block.split("\n");
    if (lines.length >= 3) {
      const timeRange = lines[1].split(" --> ");
      const startTime = parseTime(timeRange[0]);
      const endTime = parseTime(timeRange[1]);
      const text = lines.slice(2).join("\n");
      subtitles.push({ startTime, endTime, text });
    }
  });
  return subtitles;
}

function parseTime(timeStr) {
  const parts = timeStr.split(":");
  const seconds = parseFloat(parts[2].replace(",", "."));
  return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + seconds;
}

function getSubtitleForTime(subtitles, currentTime) {
  return subtitles.find(
    (subtitle) =>
      currentTime >= subtitle.startTime && currentTime <= subtitle.endTime
  );
}
