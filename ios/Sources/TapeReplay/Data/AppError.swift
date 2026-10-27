import Foundation

/// An error with a message written for the person using the app (shown in the page as it is).
struct AppError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
