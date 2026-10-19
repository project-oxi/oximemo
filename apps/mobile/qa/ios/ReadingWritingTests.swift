import XCTest
import Vision

/// Runs against the installed app. Never saves or transmits test note content.
final class ReadingWritingTests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "com.oximemo.mobile")
    var originalOrientation: UIDeviceOrientation = .unknown

    override func setUpWithError() throws {
        continueAfterFailure = false
        originalOrientation = XCUIDevice.shared.orientation
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 20))
    }

    override func tearDownWithError() throws {
        if [.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight].contains(originalOrientation) {
            XCUIDevice.shared.orientation = originalOrientation
        }
    }

    func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        #if targetEnvironment(simulator)
        attachment.name = name.replacingOccurrences(of: "physical-", with: "simulator-")
        #else
        attachment.name = name
        #endif
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func visibleLetters() throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = false
        let image = try XCTUnwrap(UIImage(data: XCUIScreen.main.screenshot().pngRepresentation)?.cgImage)
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined().uppercased().filter { $0.isLetter }
    }

    func testReadingAndWritingWithKeyboard() throws {
        capture("physical-library")
        let list = app.descendants(matching: .any).matching(identifier: "메모 목록").firstMatch
        if list.waitForExistence(timeout: 5) && list.buttons.count > 0 {
            list.buttons.firstMatch.tap()
            XCTAssertTrue(app.buttons["편집"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.keyboards.firstMatch.exists)
            capture("physical-reading")
            app.buttons["편집"].tap()
            let body = app.textViews["메모 본문"]
            XCTAssertTrue(body.waitForExistence(timeout: 5))
            if !app.keyboards.firstMatch.exists { body.tap() }
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
            capture("physical-existing-editor-keyboard")
            app.buttons["미리보기"].tap()
            XCTAssertFalse(app.keyboards.firstMatch.exists)
            app.buttons["메모 목록으로"].tap()
        }

        app.buttons["새 메모 작성"].tap()
        let title = app.textViews["메모 제목"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        title.typeText("iPhone UI check\n")
        let body = app.textViews["메모 본문"]
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        if !app.keyboards.firstMatch.exists { body.tap() }
        body.typeText("**Reading and writing**\n\n" + Array(repeating: "A line to check the caret above the keyboard.\n", count: 12).joined() + "END OF LONG NOTE")
        XCTAssertEqual(app.state, .runningForeground, "Device switched away during the input check")
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        let softwareKeyboard = app.keyboards.keys.firstMatch.waitForExistence(timeout: 5)
        #if targetEnvironment(simulator)
        if !softwareKeyboard { throw XCTSkip("Simulator exposes a hardware-keyboard accessory only. Validate the software-keyboard viewport on the physical iPhone.") }
        #else
        XCTAssertTrue(softwareKeyboard, "Show the software keyboard; an accessory bar is insufficient")
        #endif
        capture("physical-long-writing-keyboard")
        XCTAssertTrue(app.buttons["메모 저장"].isHittable)
        XCTAssertLessThan(app.buttons["메모 저장"].frame.maxY, app.keyboards.firstMatch.frame.minY)
        // Check the actual visible pixels, not just the textarea's full value.
        XCTAssertTrue(try visibleLetters().contains("ENDOFLONGNOTE"), "The last typed line must be visible above the software keyboard")
        body.swipeDown(velocity: .fast)
        body.swipeDown(velocity: .fast)
        capture("physical-writing-scroll-start")
        XCTAssertTrue(try visibleLetters().contains("READINGANDWRITING"), "The textarea must scroll back to the beginning by touch")
        for _ in 0..<6 {
            if try visibleLetters().contains("ENDOFLONGNOTE") { break }
            body.swipeUp(velocity: .fast)
        }
        capture("physical-writing-scroll-end")
        XCTAssertTrue(try visibleLetters().contains("ENDOFLONGNOTE"))
        XCTAssertTrue(app.buttons["메모 저장"].isHittable)
        app.buttons["메모 목록으로"].tap()
        XCTAssertTrue(app.buttons["계속 작성"].waitForExistence(timeout: 5))
        capture("physical-unsaved-guard")
        app.buttons["계속 작성"].tap()
        XCTAssertTrue((body.value as? String)?.contains("Reading and writing") == true)
        app.buttons["메모 목록으로"].tap()
        app.buttons["저장하지 않고 나가기"].tap()
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 5))
    }

    func testSearchAndSettingsBackStack() {
        let search = app.searchFields["메모 검색"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("oximemo-qa-no-result")
        XCTAssertTrue(app.staticTexts["검색 결과가 없어요"].waitForExistence(timeout: 5))
        capture("physical-search-keyboard")
        app.buttons["취소"].tap()
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["설정"].tap()
        XCTAssertTrue(app.buttons["PC 연결"].waitForExistence(timeout: 5))
        capture("physical-settings")
        app.buttons["PC 연결"].tap()
        XCTAssertTrue(app.buttons["설정으로"].waitForExistence(timeout: 5))
        capture("physical-connection")
        app.buttons["설정으로"].tap()
        app.buttons["메모 목록으로"].tap()
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 5))
    }

    func edgeSwipe(back: Bool) {
        let view = app.webViews.firstMatch
        let start = view.coordinate(withNormalizedOffset: CGVector(dx: back ? 0.005 : 0.995, dy: 0.45))
        let end = view.coordinate(withNormalizedOffset: CGVector(dx: back ? 0.92 : 0.08, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    func testNativeEdgeHistoryAndUnsavedGuard() {
        app.buttons["설정"].tap()
        app.buttons["PC 연결"].tap()
        XCTAssertTrue(app.buttons["설정으로"].waitForExistence(timeout: 5))
        edgeSwipe(back: true)
        XCTAssertTrue(app.buttons["PC 연결"].waitForExistence(timeout: 5))
        edgeSwipe(back: true)
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 5))
        edgeSwipe(back: false)
        XCTAssertTrue(app.buttons["PC 연결"].waitForExistence(timeout: 5))
        edgeSwipe(back: false)
        XCTAssertTrue(app.buttons["설정으로"].waitForExistence(timeout: 5))
        capture("simulator-native-forward-history")
        edgeSwipe(back: true)
        edgeSwipe(back: true)
        app.buttons["새 메모 작성"].tap()
        app.textViews["메모 제목"].typeText("Swipe guard\n")
        app.textViews["메모 본문"].typeText("Unsent draft stays here")
        edgeSwipe(back: true)
        XCTAssertTrue(app.buttons["계속 작성"].waitForExistence(timeout: 5))
        app.buttons["계속 작성"].tap()
        XCTAssertTrue((app.textViews["메모 본문"].value as? String)?.contains("Unsent draft stays here") == true)
        edgeSwipe(back: true)
        XCTAssertTrue(app.buttons["저장하지 않고 나가기"].waitForExistence(timeout: 5))
        app.buttons["저장하지 않고 나가기"].tap()
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 5))
        capture("simulator-native-back-unsaved-guard")
    }

    func testLargerSystemText() {
        let normalHeight = app.staticTexts["메모"].firstMatch.frame.height
        app.terminate()
        // Process-local UIKit preference: does not change the user's Settings.
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXXXL"]
        app.launch()
        XCTAssertTrue(app.buttons["새 메모 작성"].waitForExistence(timeout: 10))
        let enlargedHeight = app.staticTexts["메모"].firstMatch.frame.height
        XCTAssertGreaterThan(enlargedHeight, normalHeight * 1.1)
        XCTAssertTrue(app.buttons["새 메모 작성"].isHittable)
        capture("physical-larger-system-text")
        app.terminate()
        app.launchArguments = []
        app.launch()
    }

    func testSmallSystemTextWriting() throws {
        app.terminate()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXS"]
        app.launch()
        defer {
            app.terminate()
            app.launchArguments = []
            app.launch()
        }
        try testReadingAndWritingWithKeyboard()
    }
}

