// Scanning workspace pairing QR codes (client feature `camera`).
// Each caller declares which links its scanner accepts.

import SwiftUI
import VisionKit

enum QRScanner {
    /// The device has a camera that can scan, and Cate may use it.
    @MainActor static var isAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    static func isPairingLink(_ text: String) -> Bool {
        text.lowercased().hasPrefix("cate://pair?")
    }
}

struct QRScannerView: View {
    let scanned: (String) -> Void
    let cancel: () -> Void
    var accepts: (String) -> Bool = QRScanner.isPairingLink
    var instruction = "Point the camera at the QR code on your computer."

    var body: some View {
        NavigationStack {
            DataScanner(scanned: scanned, accepts: accepts)
                .ignoresSafeArea()
                .overlay(alignment: .bottom) {
                    Text(instruction)
                        .font(.callout)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.bottom, 32)
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
                }
                .toolbarBackground(.hidden, for: .navigationBar)
        }
    }
}

private struct DataScanner: UIViewControllerRepresentable {
    let scanned: (String) -> Void
    let accepts: (String) -> Bool

    func makeCoordinator() -> Coordinator { Coordinator(scanned: scanned, accepts: accepts) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        DispatchQueue.main.async { try? scanner.startScanning() }
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private var scanned: ((String) -> Void)?
        private let accepts: (String) -> Bool

        init(scanned: @escaping (String) -> Void, accepts: @escaping (String) -> Bool) {
            self.scanned = scanned
            self.accepts = accepts
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in items {
                guard case .barcode(let barcode) = item,
                      let text = barcode.payloadStringValue,
                      accepts(text),
                      let scanned else { continue }
                // Once: the scanner keeps reporting while it closes.
                self.scanned = nil
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                scanned(text)
                return
            }
        }
    }
}
